/**
 * 目标补齐 / 局部重生成测试。
 *
 *  验证：
 *  - 已 valid 的模块在 targeted retry / resume 后不会被覆盖；
 *  - 局部 regenerate 不会让已完成模块失效；
 *  - 多轮对话后续 edit 仍可用（本测试只断言 planner 不重跑已完成阶段）。
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

class SelectivePlanner implements Planner {
  constructor(private readonly handlers: Partial<Record<PlanningStage, () => PlanningStageOutput>>) {}
  calls: PlanningStage[] = [];
  async generateStage(request: PlannerRequest): Promise<PlanningStageOutput> {
    this.calls.push(request.stage);
    const handler = this.handlers[request.stage];
    if (request.stage === "basicInfo" && !handler) return { reply: "basic", modules: [{ module: "basicInfo", status: "accepted", value: { subtitle: "太原精华之旅", province: "山西", operationNotes: "待核查" } }] };
    if (!handler) throw new Error(`missing handler for ${request.stage}`);
    return handler();
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
  async suggestPoi(keyword: string) { return { poiName: `${keyword}（VBK）`, poiId: 1000 }; }
  async loadHistory() { return []; }
  async loadCurrentProduct() { return this.product; }
  async loadAcceptedModules() { return detectAcceptedModulesFromProduct(this.product); }
}

const skeleton = { destination: "太原", days: 2, nights: 1, productForm: "privateTour" as const, productType: "domesticShort" as const, supplierProductCode: "NEW" };

test("已 valid 的 presentation / itinerary 在 resume 时不会被覆盖", async () => {
  const store = new InMemoryStore();
  const rt = new FakeRuntime();
  // 第一轮只产出 itinerary 与 presentation；其它阶段会抛错，让 needs_user。
  const planner1 = new SelectivePlanner({
    itinerary: () => ({
      reply: "itin",
      modules: [{ module: "itinerary", status: "accepted", value: [
        { day: 1, title: "Day 1", spots: [{ name: "A", poiName: null, poiId: null }], description: "D1", hotel: "Hotel", meals: "B/L/D" },
        { day: 2, title: "Day 2", spots: [{ name: "B", poiName: null, poiId: null }], description: "D2", hotel: "", meals: "含早餐；午餐自理；晚餐自理" },
      ] }],
    }),
    presentation: () => ({
      reply: "pres",
      modules: [{ module: "presentation", status: "accepted", value: {
        recommendationCategory: "优选行程", recommendation: "ORIGINAL",
        recommendations: [
          { category: "优选行程", text: "a" }, { category: "精选酒店", text: "b" }, { category: "缤纷景点", text: "c" },
        ],
        features: "ORIGINAL FEAT",
      } }],
    }),
  });
  await runPlan({ localProductId: "p", skeleton, store, runtime: rt, planner: planner1, providerLabel: "minimax", options: { stageRetryLimit: 1 } });
  // 第二轮：模拟用户后续触发 resume；planner2 在 presentation 阶段如果再次生成不同内容，resume 会跳过它。
  const planner2 = new SelectivePlanner({
    commercial: () => ({
      reply: "com", modules: [
        { module: "pricing", status: "accepted", value: { currency: "CNY", adult: 1, child: 1, minimumTravelers: 1 } },
        { module: "inventory", status: "accepted", value: { startDate: "2026-08-10", endDate: "2026-12-31", dailyQuota: 1 } },
        { module: "terms", status: "accepted", value: { inclusions: "i", exclusions: "e", bookingNotes: "b", refundPolicy: "r" } },
        { module: "release", status: "accepted", value: { submitReview: false, publishAfterApproval: false, publicPriceCeiling: 1, publicAuditRetries: 1 } },
      ],
    }),
    research: () => ({ reply: "rt", modules: [{ module: "researchTasks", status: "accepted", researchTasks: [] }] }),
  });
  await runPlan({ localProductId: "p", skeleton, store, runtime: rt, planner: planner2, providerLabel: "minimax" });
  // planner2 不应被要求生成 presentation / itinerary。
  assert.ok(!planner2.calls.includes("presentation"));
  assert.ok(!planner2.calls.includes("itinerary"));
  // 产品里的 presentation.recommendation 仍是 ORIGINAL（未覆盖）。
  const pres = rt.product.presentation as { recommendation: string; features: string };
  assert.equal(pres.recommendation, "ORIGINAL");
  assert.equal(pres.features, "ORIGINAL FEAT");
});
