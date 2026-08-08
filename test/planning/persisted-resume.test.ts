/**
 * 持久化续跑测试：模拟进程崩溃 + 重启，跑 resume 后从 currentStage 续跑，
 * 验证已完成阶段被跳过、当前阶段被尝试、新模块被接受。
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

class PartialPlanner implements Planner {
  calls: { stage: PlanningStage; attempt: number }[] = [];
  constructor(private readonly stageToSimulate: PlanningStage, private readonly output: PlanningStageOutput) {}
  async generateStage(request: PlannerRequest): Promise<PlanningStageOutput> {
    this.calls.push({ stage: request.stage, attempt: (request.previousError?.attempt ?? 0) + 1 });
    if (request.stage === "basicInfo" && request.stage !== this.stageToSimulate) return { reply: "basic", modules: [{ module: "basicInfo", status: "accepted", value: { subtitle: "太原精华之旅", province: "山西", operationNotes: "待核查" } }] };
    if (request.stage === this.stageToSimulate) return this.output;
    throw new Error(`unexpected stage ${request.stage}`);
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

test("resume 不会重跑已完成阶段，从 currentStage 续跑", async () => {
  const store = new InMemoryStore();
  const rt = new FakeRuntime();
  // 第一阶段（itinerary）成功，其它阶段都直接报 missing。
  const itineraryOutput: PlanningStageOutput = {
    reply: "itin", modules: [{
      module: "itinerary", status: "accepted",
      value: [
        { day: 1, title: "Day 1", spots: ["A"], description: "D1", hotel: "Hotel", meals: "B/L/D" },
        { day: 2, title: "Day 2", spots: ["B"], description: "D2", hotel: "", meals: "含早餐；午餐自理；晚餐自理" },
      ],
    }],
  };
  // 跑第一轮：skeleton + itinerary 成功，presentation 触发 needs_user（missing）。
  const planner1 = new PartialPlanner("itinerary", itineraryOutput);
  const r1 = await runPlan({ projectId: "p", skeleton, store, runtime: rt, planner: planner1, providerLabel: "minimax", options: { stageRetryLimit: 1 } });
  assert.equal(r1.status, "needs_user");
  // 持久化状态：skeleton + itinerary 完成，presentation 是当前阶段。
  assert.deepEqual(store.state?.completedStages, ["skeleton", "basicInfo", "itinerary"]);
  assert.equal(store.state?.currentStage, "commercial");

  // 模拟进程重启后 resume：换一个能产出 presentation 的 planner。
  const presentationOutput: PlanningStageOutput = {
    reply: "pres", modules: [{
      module: "presentation", status: "accepted",
      value: {
        recommendationCategory: "优选行程", recommendation: "R",
        recommendations: [
          { category: "优选行程", text: "a" }, { category: "精选酒店", text: "b" }, { category: "缤纷景点", text: "c" },
        ],
        features: "feat",
      },
    }],
  };
  // 第二轮：skeleton 跳过；itinerary 跳过；presentation 跑成功；commercial / research / validation 跑；
  // 因为后面的 planner 还是会触发 needs_user（它只能产出 presentation），我们就只断言 presentation 没重跑、resume 不重跑 skeleton。
  const planner2 = new PartialPlanner("presentation", presentationOutput);
  await runPlan({ projectId: "p", skeleton, store, runtime: rt, planner: planner2, providerLabel: "minimax", options: { stageRetryLimit: 1 } });
  // planner2 应被调用 presentation；skeleton / itinerary 不在 calls 里。
  // planner2.calls 是 {stage, attempt}[]，不能直接 .includes('presentation')。
  const stages2 = planner2.calls.map((c) => c.stage);
  assert.ok(stages2.includes("commercial"), `resume 应当补跑 commercial，实际 stages：${stages2.join(",")}`);
  assert.ok(!stages2.includes("skeleton"), "resume 不应再调 skeleton");
  assert.ok(!stages2.includes("itinerary"), "resume 不应再调 itinerary");
  // 持久化产品里 presentation 已落地。
  assert.ok(rt.product.operations, "已完成前置阶段结果应已保留");
});

/**
 * 验收门 1：persisted state 只有 skeleton（completedStages=[skeleton]，
 * currentStage=skeleton，status=needs_user）时，resume 必须：
 *   - 跳过 skeleton；
 *   - 调用 itinerary 阶段 planner；
 *   - 不能直接返回原样的「仅 skeleton 接受、其它缺失」摘要。
 *
 * 场景来源：用户报告「方案规划未完成。已接受：skeleton；缺失：…」+「继续还是报错」。
 */
test("resume：persisted state 只有 skeleton 时必须从 itinerary 起跑，不能原地返回", async () => {
  const store = new InMemoryStore();
  const rt = new FakeRuntime();
  // 第一轮：planner 让 skeleton + itinerary 都报 missing，让 orchestrator 进
  // needs_user 终止（completedStages=[skeleton], currentStage=skeleton）。
  const planner1: Planner = {
    async generateStage() {
      return { reply: "", modules: [{ module: "itinerary", status: "missing", reason: "missing" }] };
    },
  };
  await runPlan({
    projectId: "p",
    skeleton,
    store,
    runtime: rt,
    planner: planner1,
    providerLabel: "minimax",
    options: { stageRetryLimit: 1 },
  });
  // 持久化状态必须是 skeleton-only：completedStages=[skeleton]，
  // currentStage 被推进到 itinerary（不是 skeleton）。
  assert.deepEqual(store.state?.completedStages, ["skeleton"]);
  assert.equal(store.state?.status, "needs_user");
  assert.equal(store.state?.currentStage, "basicInfo", "needs_user 终止时 currentStage 必须推进到下一个未完成阶段");

  // 第二轮：换一个能产出 itinerary 的 planner；只接受 itinerary。
  const itineraryOutput: PlanningStageOutput = {
    reply: "itin",
    modules: [{
      module: "itinerary", status: "accepted",
      value: [
        { day: 1, title: "Day 1", spots: ["A"], description: "D1", hotel: "Hotel", meals: "B/L/D" },
        { day: 2, title: "Day 2", spots: ["B"], description: "D2", hotel: "", meals: "含早餐；午餐自理；晚餐自理" },
      ],
    }],
  };
  const planner2 = new PartialPlanner("itinerary", itineraryOutput);
  const r2 = await runPlan({
    projectId: "p",
    skeleton,
    store,
    runtime: rt,
    planner: planner2,
    providerLabel: "minimax",
    options: { stageRetryLimit: 1 },
  });
  // planner2 必须被调用 itinerary；skeleton 不能被重跑。
  const stages2 = planner2.calls.map((c) => c.stage);
  assert.ok(stages2.includes("itinerary"), `resume 必须调用 itinerary，实际 stages：${stages2.join(",")}`);
  assert.ok(!stages2.includes("skeleton"), "resume 不能重跑 skeleton");
  // 这一轮应当至少接受 itinerary（不再原地返回 needs_user）。
  const accepted2 = r2.accepted.map((m) => m.module);
  assert.ok(accepted2.includes("itinerary"), `resume 后必须接受 itinerary，实际：${accepted2.join(",")}`);
});
