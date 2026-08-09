/**
 * provider 等价测试：用 minimax / deepseek 两个 provider label 跑同一份脚本，
 * 应当产出等价的产品、状态、研究任务清单。orchestrator / planner 不应该
 * 分支依赖 provider 名字。
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

interface ScriptEntry { stage: PlanningStage; output: PlanningStageOutput }
function buildScript(): ScriptEntry[] {
  return [
    { stage: "basicInfo", output: { reply: "basic", modules: [{ module: "basicInfo", status: "accepted", value: { subtitle: "太原精华之旅", province: "山西", operationNotes: "待核查" } }] } },
    { stage: "itinerary", output: { reply: "itin", modules: [{ module: "itinerary", status: "accepted", value: [
      { day: 1, title: "Day 1", spots: [{ name: "Spot A", poiName: null, poiId: null }], description: "D1", hotel: "Hotel", meals: "B/L/D" },
      { day: 2, title: "Day 2", spots: [{ name: "Spot B", poiName: null, poiId: null }], description: "D2", hotel: "", meals: "含早餐；午餐自理；晚餐自理" },
    ] }] } },
    { stage: "presentation", output: { reply: "pres", modules: [{ module: "presentation", status: "accepted", value: {
      recommendationCategory: "优选行程", recommendation: "R", recommendations: [
        { category: "优选行程", text: "a" }, { category: "精选酒店", text: "b" }, { category: "缤纷景点", text: "c" },
      ], features: "feat",
    } }] } },
    { stage: "commercial", output: { reply: "com", modules: [
      { module: "packageName", status: "accepted", value: "pkg" },
      { module: "pricing", status: "accepted", value: { currency: "CNY", adult: 1000, child: 500, minimumTravelers: 2 } },
      { module: "inventory", status: "accepted", value: { startDate: "2026-08-10", endDate: "2026-12-31", dailyQuota: 6 } },
      { module: "terms", status: "accepted", value: { inclusions: "i", exclusions: "e", bookingNotes: "b", refundPolicy: "r" } },
      { module: "release", status: "accepted", value: { submitReview: false, publishAfterApproval: false, publicPriceCeiling: 3000, publicAuditRetries: 4 } },
    ] } },
    // research 阶段由本地 deterministic 生成，不再出现在脚本中。
  ];
}

class ScriptedPlanner implements Planner {
  calls = 0;
  constructor(private readonly label: string, private readonly script: ScriptEntry[]) {}
  async generateStage(request: PlannerRequest): Promise<PlanningStageOutput> {
    this.calls += 1;
    const entry = this.script.find((s) => s.stage === request.stage);
    if (!entry) throw new Error("missing script entry " + request.stage);
    // 故意把 provider 标签写到 reply 里，看 orchestrator 是否会被影响。
    return { ...entry.output, reply: `${entry.output.reply} (${this.label})` };
  }
}

class InMemoryStore implements GenerationStateStore {
  state?: PlanningGenerationState;
  load() { return Promise.resolve(this.state); }
  save(state: PlanningGenerationState) { this.state = state; return Promise.resolve(); }
}

class FakeRuntime implements OrchestratorRuntime {
  product: Record<string, unknown> = { basicInfo: { province: "山西" } };
  tasks: ResearchTaskProposal[] = [];
  async loadExistingResearchTasks(): Promise<Array<Pick<ResearchTaskProposal, "label" | "type">>> {
    return this.tasks.map((t) => ({ label: t.label, type: t.type }));
  }
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
  async addResearchTask(_id: string, task: ResearchTaskProposal) {
    this.tasks.push(task);
    return task.label;
  }
  async loadHistory() { return []; }
  async loadCurrentProduct() { return this.product; }
  async loadAcceptedModules() { return detectAcceptedModulesFromProduct(this.product); }
}

const skeleton = { destination: "太原", days: 2, nights: 1, productForm: "privateTour" as const, productType: "domesticShort" as const, supplierProductCode: "NEW" };

test("minimax 与 deepseek label 跑同一脚本应产出等价产品 / 状态 / research tasks", async () => {
  const storeA = new InMemoryStore();
  const rtA = new FakeRuntime();
  const plannerA = new ScriptedPlanner("minimax", buildScript());
  const a = await runPlan({ projectId: "pA", skeleton, store: storeA, runtime: rtA, planner: plannerA, providerLabel: "minimax" });

  const storeB = new InMemoryStore();
  const rtB = new FakeRuntime();
  const plannerB = new ScriptedPlanner("deepseek", buildScript());
  const b = await runPlan({ projectId: "pB", skeleton, store: storeB, runtime: rtB, planner: plannerB, providerLabel: "deepseek" });

  assert.equal(a.status, b.status);
  assert.deepEqual(
    a.accepted.map((m) => m.module).sort(),
    b.accepted.map((m) => m.module).sort(),
  );
  assert.deepEqual(a.researchTasks, b.researchTasks);
  // 持久化产品里的 presentation.recommendation 必须一致；orchestrator 不应当
  // 抄模型 reply（写入了 provider 标签）。
  const aRec = (rtA.product.presentation as { recommendation: string }).recommendation;
  const bRec = (rtB.product.presentation as { recommendation: string }).recommendation;
  assert.equal(aRec, bRec);
});

test("orchestrator 回复文本不抄 provider 标签", async () => {
  const store = new InMemoryStore();
  const rt = new FakeRuntime();
  const planner = new ScriptedPlanner("minimax", buildScript());
  const result = await runPlan({ projectId: "p", skeleton, store, runtime: rt, planner, providerLabel: "minimax" });
  assert.ok(!result.assistantReply.includes("(minimax)"), `assistant reply 不应抄 provider 标签：${result.assistantReply}`);
});
