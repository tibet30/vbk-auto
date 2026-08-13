/**
 * Revalidation + rewind 测试：
 *  - state.status / completedStages 单独不可信；revalidate 必须 deep-validate；
 *  - 持久化产品被「运营 / 手工改坏」后，resume 必须 rewind 到负责阶段；
 *  - shallow detectAcceptedModules 必须足够深，让「2 天骨架 + 1 天 itinerary」
 *    被识别为非法并触发 itinerary 重跑；
 *  - 同样覆盖商业子模块（如 release / pricing）。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { runPlan } from "../../src/main/planning/plan-orchestrator.js";
import {
  detectAcceptedModulesFromProduct,
} from "../../src/main/planning/runtime.js";
import type {
  GenerationStateStore, OrchestratorRuntime,
} from "../../src/main/planning/types.js";
import type {
  Planner, PlannerRequest, PlanningStageOutput, PlanningGenerationState, PlanningModule, PlanningStage, ResearchTaskProposal,
} from "../../src/shared/contracts-planning.js";
import { AI_WRITABLE_PATHS } from "../../src/main/planning/schemas.js";

class ScriptedPlanner implements Planner {
  constructor(private readonly script: Partial<Record<PlanningStage, PlanningStageOutput>>) {}
  calls: PlanningStage[] = [];
  async generateStage(request: PlannerRequest): Promise<PlanningStageOutput> {
    this.calls.push(request.stage);
    const out = this.script[request.stage];
    if (request.stage === "basicInfo" && !out) return { reply: "basic", modules: [{ module: "basicInfo", status: "accepted", value: { subtitle: "太原精华之旅", province: "山西", operationNotes: "待核查" } }] };
    if (!out) throw new Error(`未编排阶段 ${request.stage}`);
    return out;
  }
}

class InMemoryStore implements GenerationStateStore {
  state?: PlanningGenerationState;
  load() { return Promise.resolve(this.state); }
  save(s: PlanningGenerationState) { this.state = s; return Promise.resolve(); }
}

class FakeRuntime implements OrchestratorRuntime {
  product: Record<string, unknown> = { basicInfo: { province: "山西" } };
  /**
   * 模拟「运营 / 手工改坏」持久化产品：每次 loadAcceptedModules 都重新检测。
   * 这样检测函数与 runtime 持久化的真相保持一致。
   */
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
  async loadAcceptedModules(): Promise<PlanningModule[]> {
    // FakeRuntime 不主动携带 basicInfo（它在 DbOrchestratorRuntime 里由
    // db.createProduct 填入）。为了让 detectAcceptedModulesFromProduct 对
    // itinerary / presentation 走「骨架对齐」分支，运行时补一个最小的 basicInfo。
    // 这是与真实 DB 路径的等价语义：DbOrchestratorRuntime.loadAcceptedModules
    // 永远能看到骨架里的 basicInfo.days。
    const productWithBasicInfo: Record<string, unknown> = {
      ...this.product,
      basicInfo: {
        days: 2,
        nights: 1,
        supplierProductCode: "NEW",
        ...(this.product.basicInfo && typeof this.product.basicInfo === "object" && !Array.isArray(this.product.basicInfo)
          ? this.product.basicInfo as Record<string, unknown>
          : {}),
      },
    };
    return detectAcceptedModulesFromProduct(productWithBasicInfo);
  }
}

const skeleton = { destination: "太原", days: 2, nights: 1, productForm: "privateTour" as const, productType: "domesticShort" as const, supplierProductCode: "NEW" };

test("detectAcceptedModulesFromProduct 在骨架 2 天但 itinerary 只 1 天时不会把 itinerary 算 accepted", () => {
  // 这是 rewind 机制的「前置检测」：shallow 检测必须足够深，避免「2 天骨架 +
  // 1 天 itinerary」被永久当成 accepted 跳过。该用例以前会让 itinerary 缺失
  // 一半天数的非法产品「过」validation → 直接标 completed；deepened detection
  // 直接拒绝把它当 accepted，让 orchestrator 把它当 missing 处理。
  const product: Record<string, unknown> = {
    basicInfo: { days: 2, nights: 1, supplierProductCode: "NEW" },
    itinerary: [
      { day: 1, title: "D1", spots: [{ name: "A", poiName: null, poiId: null }], description: "D", meals: "M" },
    ],
  };
  const accepted = detectAcceptedModulesFromProduct(product);
  assert.ok(!accepted.includes("itinerary"), "itinerary 长度 != basicInfo.days 时不应被算 accepted");
});

test("detectAcceptedModulesFromProduct 对 presentation 三条 recommendations 缺字段也拒绝", () => {
  const product = {
    presentation: {
      recommendationCategory: "优选行程",
      recommendation: "R",
      recommendations: [
        { category: "优选行程", text: "a" },
        { category: "精选酒店", text: "b" },
        { category: "", text: "" },
      ],
      features: "f",
    },
  };
  const accepted = detectAcceptedModulesFromProduct(product);
  assert.ok(!accepted.includes("presentation"), "recommendations 缺 category/text 时不应被算 accepted");
});

test("detectAcceptedModulesFromProduct 对 itinerary days 顺序错乱也拒绝", () => {
  const product = {
    basicInfo: { days: 2, nights: 1, supplierProductCode: "NEW" },
    itinerary: [
      { day: 1, title: "D1", spots: [{ name: "A", poiName: null, poiId: null }], description: "D", meals: "M" },
      { day: 1, title: "D1-dup", spots: [{ name: "B", poiName: null, poiId: null }], description: "D", meals: "M" },
    ],
  };
  const accepted = detectAcceptedModulesFromProduct(product);
  assert.ok(!accepted.includes("itinerary"));
});

test("resume 检测到非法 1-day itinerary → 状态 needs_user 且 currentStage=itinerary", async () => {
  const store = new InMemoryStore();
  const rt = new FakeRuntime();
  // 第一次跑完整流程：planner 输出 valid 2 天 itinerary，让状态走到 completed。
  const fullOutputs: Partial<Record<PlanningStage, PlanningStageOutput>> = {
    itinerary: {
      reply: "itin",
      modules: [{ module: "itinerary", status: "accepted", value: [
        { day: 1, title: "D1", spots: [{ name: "A", poiName: null, poiId: null }], description: "D", hotel: "H", meals: "B/L/D" },
        { day: 2, title: "D2", spots: [{ name: "B", poiName: null, poiId: null }], description: "D", hotel: "", meals: "B/L/D" },
      ] }],
    },
    presentation: { reply: "p", modules: [{ module: "presentation", status: "accepted", value: {
      recommendationCategory: "优选行程",
      recommendation: "R",
      recommendations: [
        { category: "优选行程", text: "a" }, { category: "精选酒店", text: "b" }, { category: "缤纷景点", text: "c" },
      ],
      features: "f",
    } }] },
    commercial: { reply: "c", modules: [
      { module: "packageName", status: "accepted", value: "pkg" },
      { module: "pricing", status: "accepted", value: { currency: "CNY", adult: 1000, child: 500, minimumTravelers: 2 } },
      { module: "inventory", status: "accepted", value: { startDate: "2026-08-10", endDate: "2026-12-31", dailyQuota: 6 } },
      { module: "terms", status: "accepted", value: { inclusions: "i", exclusions: "e", bookingNotes: "b", refundPolicy: "r" } },
      { module: "release", status: "accepted", value: { submitReview: false, publishAfterApproval: false, publicPriceCeiling: 3000, publicAuditRetries: 4 } },
    ] },
  };
  const planner1 = new ScriptedPlanner(fullOutputs);
  await runPlan({ localProductId: "p", skeleton, store, runtime: rt, planner: planner1, providerLabel: "minimax" });
  // 第一轮跑完：state.status === "completed"，completedStages 包含所有阶段。
  assert.equal(store.state?.status, "completed");
  assert.deepEqual(store.state?.completedStages, ["skeleton", "basicInfo", "itinerary", "presentation", "commercial", "research", "validation"]);
  // 模拟「运营 / 手工改坏」持久化 itinerary：2 天骨架只剩 1 天。
  rt.product = {
    ...rt.product,
    itinerary: [
      { day: 1, title: "D1", spots: [{ name: "A", poiName: null, poiId: null }], description: "D", hotel: "H", meals: "B/L/D" },
    ],
  };
  // 第二次 resume：planner 仍然只产 1 天行程（跟 corrupt 后一致，模拟 AI / 运营
  // 始终给不出 2 天）。resume 必须触发 rewind，重跑 itinerary，重跑后仍然
  // 非法 → status=needs_user，currentStage 停在 itinerary，completedStages
  // 不再含 itinerary。这是用户明确点名的「1-day 对 2-day 骨架」回归。
  const brokenOutputs: Partial<Record<PlanningStage, PlanningStageOutput>> = {
    ...fullOutputs,
    itinerary: {
      reply: "itin-broken",
      modules: [{ module: "itinerary", status: "accepted", value: [
        { day: 1, title: "D1", spots: [{ name: "A", poiName: null, poiId: null }], description: "D", hotel: "H", meals: "B/L/D" },
      ] }],
    },
  };
  const planner2 = new ScriptedPlanner(brokenOutputs);
  const r2 = await runPlan({ localProductId: "p", skeleton, store, runtime: rt, planner: planner2, providerLabel: "minimax" });
  assert.equal(r2.status, "needs_user", "非法 itinerary 触发 rewind → needs_user");
  assert.equal(store.state?.status, "needs_user");
  assert.equal(store.state?.currentStage, "itinerary", "rewind 到 earliest invalid stage = itinerary");
  // planner2 必须实际跑 itinerary（rewind 后 completedStages 不再含 itinerary）。
  assert.ok(planner2.calls.includes("itinerary"), "rewind 后 resume 必须重跑 itinerary");
});

test("resume 检测到非法 release 子模块（publicPriceCeiling 缺失）→ rewind 到 commercial", async () => {
  const store = new InMemoryStore();
  const rt = new FakeRuntime();
  const fullOutputs: Partial<Record<PlanningStage, PlanningStageOutput>> = {
    itinerary: { reply: "i", modules: [{ module: "itinerary", status: "accepted", value: [
      { day: 1, title: "D1", spots: [{ name: "A", poiName: null, poiId: null }], description: "D", hotel: "H", meals: "B/L/D" },
      { day: 2, title: "D2", spots: [{ name: "B", poiName: null, poiId: null }], description: "D", hotel: "", meals: "B/L/D" },
    ] }] },
    presentation: { reply: "p", modules: [{ module: "presentation", status: "accepted", value: {
      recommendationCategory: "优选行程",
      recommendation: "R",
      recommendations: [
        { category: "优选行程", text: "a" }, { category: "精选酒店", text: "b" }, { category: "缤纷景点", text: "c" },
      ],
      features: "f",
    } }] },
    commercial: { reply: "c", modules: [
      { module: "packageName", status: "accepted", value: "pkg" },
      { module: "pricing", status: "accepted", value: { currency: "CNY", adult: 1000, child: 500, minimumTravelers: 2 } },
      { module: "inventory", status: "accepted", value: { startDate: "2026-08-10", endDate: "2026-12-31", dailyQuota: 6 } },
      { module: "terms", status: "accepted", value: { inclusions: "i", exclusions: "e", bookingNotes: "b", refundPolicy: "r" } },
      { module: "release", status: "accepted", value: { submitReview: false, publishAfterApproval: false, publicPriceCeiling: 3000, publicAuditRetries: 4 } },
    ] },
  };
  const planner1 = new ScriptedPlanner(fullOutputs);
  await runPlan({ localProductId: "p", skeleton, store, runtime: rt, planner: planner1, providerLabel: "minimax" });
  assert.equal(store.state?.status, "completed");
  // 改坏 release 子模块：把 publicPriceCeiling 抹掉。
  rt.product = {
    ...rt.product,
    commercial: {
      ...((rt.product.commercial ?? {}) as Record<string, unknown>),
      release: { submitReview: false, publishAfterApproval: false, publicAuditRetries: 4 },
    },
  };
  // planner2 仍然输出 release 但 publicPriceCeiling 缺失 → 重跑后仍然不合法。
  const brokenOutputs: Partial<Record<PlanningStage, PlanningStageOutput>> = {
    ...fullOutputs,
    commercial: { reply: "c-broken", modules: [
      { module: "packageName", status: "accepted", value: "pkg" },
      { module: "pricing", status: "accepted", value: { currency: "CNY", adult: 1000, child: 500, minimumTravelers: 2 } },
      { module: "inventory", status: "accepted", value: { startDate: "2026-08-10", endDate: "2026-12-31", dailyQuota: 6 } },
      { module: "terms", status: "accepted", value: { inclusions: "i", exclusions: "e", bookingNotes: "b", refundPolicy: "r" } },
      { module: "release", status: "accepted", value: { submitReview: false, publishAfterApproval: false, publicAuditRetries: 4 } },
    ] },
  };
  const planner2 = new ScriptedPlanner(brokenOutputs);
  const r2 = await runPlan({ localProductId: "p", skeleton, store, runtime: rt, planner: planner2, providerLabel: "minimax" });
  assert.equal(r2.status, "needs_user", "非法 release 触发 rewind → needs_user");
  assert.equal(store.state?.currentStage, "commercial", "release 属于 commercial 阶段 → rewind 到 commercial");
  // planner2 必须重跑 commercial。
  assert.ok(planner2.calls.includes("commercial"), "rewind 后必须重跑 commercial");
});

test("rewind 不会清除比 invalid 阶段更早的合法 completedStages", async () => {
  const store = new InMemoryStore();
  const rt = new FakeRuntime();
  const fullOutputs: Partial<Record<PlanningStage, PlanningStageOutput>> = {
    itinerary: { reply: "i", modules: [{ module: "itinerary", status: "accepted", value: [
      { day: 1, title: "D1", spots: [{ name: "A", poiName: null, poiId: null }], description: "D", hotel: "H", meals: "B/L/D" },
      { day: 2, title: "D2", spots: [{ name: "B", poiName: null, poiId: null }], description: "D", hotel: "", meals: "B/L/D" },
    ] }] },
    presentation: { reply: "p", modules: [{ module: "presentation", status: "accepted", value: {
      recommendationCategory: "优选行程",
      recommendation: "R",
      recommendations: [
        { category: "优选行程", text: "a" }, { category: "精选酒店", text: "b" }, { category: "缤纷景点", text: "c" },
      ],
      features: "f",
    } }] },
    commercial: { reply: "c", modules: [
      { module: "packageName", status: "accepted", value: "pkg" },
      { module: "pricing", status: "accepted", value: { currency: "CNY", adult: 1000, child: 500, minimumTravelers: 2 } },
      { module: "inventory", status: "accepted", value: { startDate: "2026-08-10", endDate: "2026-12-31", dailyQuota: 6 } },
      { module: "terms", status: "accepted", value: { inclusions: "i", exclusions: "e", bookingNotes: "b", refundPolicy: "r" } },
      { module: "release", status: "accepted", value: { submitReview: false, publishAfterApproval: false, publicPriceCeiling: 3000, publicAuditRetries: 4 } },
    ] },
  };
  const planner1 = new ScriptedPlanner(fullOutputs);
  await runPlan({ localProductId: "p", skeleton, store, runtime: rt, planner: planner1, providerLabel: "minimax" });
  // 改坏 itinerary。skeleton 仍然是合法的（rewind 时不应被清掉）。
  rt.product = {
    ...rt.product,
    itinerary: [
      { day: 1, title: "D1", spots: [{ name: "A", poiName: null, poiId: null }], description: "D", hotel: "H", meals: "B/L/D" },
    ],
  };
  // planner2 仍只输出 1 天行程，保证 rewind + 重跑后状态仍停在 needs_user，
  // 不会被「重跑一下就过了」掩盖 rewind 的语义。
  const brokenOutputs: Partial<Record<PlanningStage, PlanningStageOutput>> = {
    ...fullOutputs,
    itinerary: { reply: "i-broken", modules: [{ module: "itinerary", status: "accepted", value: [
      { day: 1, title: "D1", spots: [{ name: "A", poiName: null, poiId: null }], description: "D", hotel: "H", meals: "B/L/D" },
    ] }] },
  };
  const planner2 = new ScriptedPlanner(brokenOutputs);
  await runPlan({ localProductId: "p", skeleton, store, runtime: rt, planner: planner2, providerLabel: "minimax" });
  assert.equal(store.state?.status, "needs_user");
  assert.equal(store.state?.currentStage, "itinerary");
  assert.ok(store.state?.completedStages.includes("skeleton"), "skeleton 是 itinerary 之前合法完成的阶段，必须保留");
  assert.ok(store.state?.completedStages.includes("basicInfo"), "basicInfo 是 itinerary 之前合法完成的阶段，必须保留");
  assert.ok(!store.state?.completedStages.includes("itinerary"));
  assert.ok(!store.state?.completedStages.includes("presentation"));
  assert.ok(!store.state?.completedStages.includes("commercial"));
  assert.ok(!store.state?.completedStages.includes("research"));
  assert.ok(!store.state?.completedStages.includes("validation"));
});
