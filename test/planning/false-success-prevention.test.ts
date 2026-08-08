/**
 * 验证「部分模块通过 + 部分模块缺失」不会被识别为 completed，也不会发「完成」声明。
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

class OneValidPlanner implements Planner {
  calls: PlanningStage[] = [];
  async generateStage(request: PlannerRequest): Promise<PlanningStageOutput> {
    this.calls.push(request.stage);
    if (request.stage === "itinerary") {
      return {
        reply: "已生成行程，方案完成", // 模型声称完成 → 不可信
        modules: [{
          module: "itinerary", status: "accepted",
          value: [
            { day: 1, title: "Day 1", spots: ["Spot"], description: "D1", hotel: "Hotel", meals: "B/L/D" },
            { day: 2, title: "Day 2", spots: ["Spot"], description: "D2", hotel: "", meals: "含早餐；午餐自理；晚餐自理" },
          ],
        }],
      };
    }
    // 其它阶段：模型声称「missing」。
    return { reply: "本阶段没产出", modules: [{ module: "presentation", status: "missing", reason: "missing" }] };
  }
}

class InMemoryStore implements GenerationStateStore {
  state?: PlanningGenerationState;
  load() { return Promise.resolve(this.state); }
  save(s: PlanningGenerationState) { this.state = s; return Promise.resolve(); }
}

class FakeRuntime implements OrchestratorRuntime {
  product: Record<string, unknown> = {};
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

test("部分模块缺失时，状态进入 needs_user，不发完成声明", async () => {
  const store = new InMemoryStore();
  const rt = new FakeRuntime();
  const planner = new OneValidPlanner();
  const result = await runPlan({ projectId: "p", skeleton, store, runtime: rt, planner, providerLabel: "minimax" });
  assert.equal(result.status, "needs_user");
  // 缺失的模块应当被报告出来。
  const rejectedNames = result.rejected.map((m) => m.module);
  assert.ok(rejectedNames.includes("presentation"), `应当报告 presentation 缺失，实际：${rejectedNames.join(",")}`);
  assert.ok(rejectedNames.includes("pricing"));
  // assistant reply 不能包含「完成 / 全部完成 / 一切就绪」之类虚假措辞。
  assert.ok(!/完成|已成功|全部/.test(result.assistantReply) || result.assistantReply.includes("未完成"),
    `assistant reply 不应虚假声称完成：${result.assistantReply}`);
});

test("包含禁写字段的模块会被拒，且原因包含字段名", async () => {
  const store = new InMemoryStore();
  const rt = new FakeRuntime();
  const planner: Planner = {
    async generateStage(): Promise<PlanningStageOutput> {
      return {
        reply: "尝试写入 supplierProductCode",
        modules: [{
          module: "itinerary", status: "accepted",
          value: [
            { day: 1, title: "Day 1", spots: ["Spot"], description: "D1", hotel: "Hotel", meals: "B/L/D" },
            { day: 2, title: "Day 2", spots: ["Spot"], description: "D2", hotel: "", meals: "含早餐；午餐自理；晚餐自理" },
          ],
        }, {
          module: "presentation", status: "accepted",
          value: {
            recommendationCategory: "优选行程",
            recommendation: "R",
            recommendations: [
              { category: "优选行程", text: "a" }, { category: "精选酒店", text: "b" }, { category: "缤纷景点", text: "c" },
            ],
            features: "feat",
            // 禁写字段：supplierProductCode
            supplierProductCode: "TY-SJT-2D1N-001",
          },
        }],
      };
    },
  };
  const result = await runPlan({ projectId: "p", skeleton, store, runtime: rt, planner, providerLabel: "minimax" });
  // presentation 阶段因黑名单字段被拒，进入 needs_user。
  assert.equal(result.status, "needs_user");
  // 阶段级 rejected 里能查到原因（result.rejected 是 validation 级别的 missing）。
  const presentationStage = result.state.stages.find((s) => s.stage === "presentation");
  assert.ok(presentationStage, "presentation 阶段应存在");
  const presRejection = presentationStage.rejected.find((m) => m.module === "presentation");
  assert.ok(presRejection, "presentation 在阶段级 rejected 中应当存在");
  assert.ok(/supplierProductCode/.test(presRejection.reason ?? ""), `reason 应包含字段名，实际：${presRejection.reason}`);
});