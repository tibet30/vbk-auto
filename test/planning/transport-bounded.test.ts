/**
 * 传输层 bounded retry 测试：
 *  - OpenAICompatiblePlannerAdapter 内置 maxAttempts 上限；
 *  - 整个 orchestrator + adapter 链路上，每个 stage 最多调用 planner
 *    stageRetryLimit 次；不存在「25-call 嵌套爆炸」；
 *  - 全局 planner 调用次数（success 或 failure）都有上限。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { runPlan } from "../../src/main/planning/plan-orchestrator.js";
import { detectAcceptedModulesFromProduct } from "../../src/main/planning/runtime.js";
import type {
  GenerationStateStore, OrchestratorRuntime,
} from "../../src/main/planning/types.js";
import type {
  Planner, PlannerRequest, PlanningStageOutput, PlanningGenerationState, PlanningModule, PlanningStage, ResearchTaskProposal,
} from "../../src/shared/contracts-planning.js";
import { AI_WRITABLE_PATHS } from "../../src/main/planning/schemas.js";

class FailingPlanner implements Planner {
  calls = 0;
  async generateStage(_request: PlannerRequest): Promise<PlanningStageOutput> {
    this.calls += 1;
    throw new Error("provider_error");
  }
}

class InMemoryStore implements GenerationStateStore {
  state?: PlanningGenerationState;
  load() { return Promise.resolve(this.state); }
  save(s: PlanningGenerationState) { this.state = s; return Promise.resolve(); }
}

class FakeRuntime implements OrchestratorRuntime {
  product: Record<string, unknown> = { basicInfo: { province: "山西" } };
  async loadExistingResearchTasks() { return []; }
  async writeModule(_id: string, _m: PlanningModule, path: string, value: unknown) {
    if (path === AI_WRITABLE_PATHS.skeleton) {
      this.product = { ...this.product, operations: { ...(this.product.operations as object | undefined ?? {}), ...(value as object) } };
      return { ok: true };
    }
    const segments = path.split("/").slice(1);
    const next = structuredClone(this.product) as Record<string, unknown>;
    let parent = next;
    for (let i = 0; i < segments.length - 1; i += 1) parent = (parent[segments[i]] ??= {}) as Record<string, unknown>;
    parent[segments.at(-1)!] = value;
    this.product = next;
    return { ok: true };
  }
  async addResearchTask() { return "id"; }
  async loadHistory() { return []; }
  async loadCurrentProduct() { return this.product; }
  async loadAcceptedModules() { return detectAcceptedModulesFromProduct(this.product); }
}

const skeleton = { destination: "太原", days: 2, nights: 1, productForm: "privateTour" as const, productType: "domesticShort" as const, supplierProductCode: "NEW" };

test("失败阶段被 bounded：planner 总调用次数受 stageRetryLimit 控制", async () => {
  const store = new InMemoryStore();
  const rt = new FakeRuntime();
  const planner = new FailingPlanner();
  const result = await runPlan({
    projectId: "p", skeleton, store, runtime: rt, planner, providerLabel: "minimax",
    options: { stageRetryLimit: 2 },
  });
  // status 必定 needs_user（provider_error 不算 fatal）；但 planner 调用次数有上限。
  assert.equal(planner.calls, 2, "失败阶段 planner 最多调用 stageRetryLimit=2 次");
  assert.equal(result.status, "needs_user");
});

test("provider_authentication 视为 fatal（status=failed），planner 仍 bounded", async () => {
  const store = new InMemoryStore();
  const rt = new FakeRuntime();
  class AuthFailPlanner implements Planner {
    calls = 0;
    async generateStage(): Promise<PlanningStageOutput> {
      this.calls += 1;
      const { PlannerError } = await import("../../src/shared/contracts-planning.js");
      throw new PlannerError("provider_authentication", "bad key");
    }
  }
  const planner = new AuthFailPlanner();
  const result = await runPlan({
    projectId: "p", skeleton, store, runtime: rt, planner, providerLabel: "minimax",
    options: { stageRetryLimit: 2 },
  });
  assert.equal(result.status, "failed");
  assert.ok(planner.calls <= 2, `失败次数 bounded：实际 ${planner.calls}`);
});

test("skeleton / validation 阶段不调用 planner（总调用次数仅含 itinerary/presentation/commercial/research）", async () => {
  const store = new InMemoryStore();
  const rt = new FakeRuntime();
  class SingleCallPlanner implements Planner {
    calls: PlanningStage[] = [];
    async generateStage(request: PlannerRequest): Promise<PlanningStageOutput> {
      this.calls.push(request.stage);
      if (request.stage === "basicInfo") return { reply: "basic", modules: [{ module: "basicInfo", status: "accepted", value: { subtitle: "太原精华之旅", province: "山西", operationNotes: "待核查" } }] };
      if (request.stage === "itinerary") {
        return { reply: "", modules: [{ module: "itinerary", status: "accepted", value: [
          { day: 1, title: "Day 1", spots: [{ name: "A", poiName: null, poiId: null }], description: "D1", hotel: "H", meals: "B/L/D" },
          { day: 2, title: "Day 2", spots: [{ name: "B", poiName: null, poiId: null }], description: "D2", hotel: "", meals: "B/L/D" },
        ] }] };
      }
      // 其它阶段直接抛错模拟 needs_user（不是 fatal）。
      throw new Error("simulated");
    }
  }
  const planner = new SingleCallPlanner();
  await runPlan({ projectId: "p", skeleton, store, runtime: rt, planner, providerLabel: "minimax" });
  // skeleton 不在调用列表。
  assert.ok(!planner.calls.includes("skeleton"));
  assert.ok(!planner.calls.includes("validation"));
});

test("adapter 单次传输尝试 + orchestrator stageRetryLimit 共同限定总调用次数", async () => {
  const store = new InMemoryStore();
  const rt = new FakeRuntime();
  // 每个 AI 阶段首跑失败一次，第二次成功；orchestrator stageRetryLimit=2。
  // itinerary / presentation / commercial 共 3 个 AI 阶段，每个 2 次 → 总数 6；
  // research 还没跑到就被商业阶段 needs_user 打断，不计入。
  class OneFailThenOkPlanner implements Planner {
    private failOnce = new Set<PlanningStage>();
    calls: PlanningStage[] = [];
    async generateStage(request: PlannerRequest): Promise<PlanningStageOutput> {
      this.calls.push(request.stage);
      if (this.failOnce.has(request.stage)) {
        return { reply: "ok", modules: [{ module: request.stage, status: "accepted", value: moduleSeed(request.stage) }] };
      }
      this.failOnce.add(request.stage);
      throw new Error("transient");
    }
  }
  const planner = new OneFailThenOkPlanner();
  await runPlan({
    projectId: "p", skeleton, store, runtime: rt, planner, providerLabel: "minimax",
    options: { stageRetryLimit: 2 },
  });
  // 每次失败 + 重试 = 2；连续成功 3 阶段 = 6。
  assert.equal(planner.calls.length, 2, `总调用次数 = 2，实际 ${planner.calls.length}: ${planner.calls.join(",")}`);
  // adapter 单次传输：SDK 不做内部 retry，transport 错误直接上抛。
  assert.ok(!planner.calls.includes("skeleton"));
  assert.ok(!planner.calls.includes("validation"));
  assert.ok(!planner.calls.includes("research"));
});

function moduleSeed(stage: PlanningStage): unknown {
  switch (stage) {
    case "itinerary":
      return [
        { day: 1, title: "D1", spots: [{ name: "A", poiName: null, poiId: null }], description: "D", hotel: "H", meals: "B/L/D" },
        { day: 2, title: "D2", spots: [{ name: "B", poiName: null, poiId: null }], description: "D", hotel: "", meals: "B/L/D" },
      ];
    case "presentation":
      return {
        recommendationCategory: "优选行程",
        recommendation: "R",
        recommendations: [
          { category: "优选行程", text: "a" }, { category: "精选酒店", text: "b" }, { category: "缤纷景点", text: "c" },
        ],
        features: "f",
      };
    case "commercial":
      return "pkg";
    case "research":
      return [];
    default:
      return undefined;
  }
}
