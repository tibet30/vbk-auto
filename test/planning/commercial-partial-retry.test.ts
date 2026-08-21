/**
 * commercial 阶段「partial retry」测试：
 *  - 第一轮本地生成 packageName，AI 只给出 pricing → 状态进 needs_user，
 *    缺失 inventory / release；
 *  - 第二次 resume：已落地模块（packageName + pricing）不被覆盖，AI 只需
 *    补齐剩余两个；
 *  - 已落地数据保持原值（不被重置）。
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

class PartialCommercialPlanner implements Planner {
  constructor(private readonly mode: "first" | "second") {}
  calls: PlanningStage[] = [];
  async generateStage(request: PlannerRequest): Promise<PlanningStageOutput> {
    this.calls.push(request.stage);
    if (request.stage === "basicInfo") return { reply: "basic", modules: [{ module: "basicInfo", status: "accepted", value: { subtitle: "太原精华之旅", province: "山西", operationNotes: "待核查" } }] };
    if (request.stage === "itinerary") {
      return {
        reply: "itin",
        modules: [{ module: "itinerary", status: "accepted", value: [
          { day: 1, title: "D1", spots: [{ name: "晋祠", poiName: null, poiId: null }], description: "D", hotel: "H", meals: "B/L/D" },
          { day: 2, title: "D2", spots: [{ name: "山西博物院", poiName: null, poiId: null }], description: "D", hotel: "", meals: "B/L/D" },
        ] }],
      };
    }
    if (request.stage === "presentation") {
      return {
        reply: "pres",
        modules: [{ module: "presentation", status: "accepted", value: {
          recommendationCategory: "优选行程", recommendation: "R",
          recommendations: [
            { category: "优选行程", text: "a" }, { category: "精选酒店", text: "b" }, { category: "缤纷景点", text: "c" },
          ],
          features: "f",
        } }],
      };
    }
    if (request.stage === "commercial") {
      if (this.mode === "first") {
        // 第一轮：本地已写 packageName，AI 仅给 pricing；缺 inventory / release。
        return {
          reply: "com",
          modules: [
            { module: "pricing", status: "accepted", value: { currency: "CNY", adult: 1000, child: 500, minimumTravelers: 2 } },
          ],
        };
      }
      // 第二轮：补齐剩余两个模块；条款由 VBK 自动化阶段处理。
      return {
        reply: "com-fill",
        modules: [
          { module: "inventory", status: "accepted", value: { startDate: "2026-08-10", endDate: "2026-12-31", dailyQuota: 6 } },
          { module: "release", status: "accepted", value: { submitReview: false, publishAfterApproval: false, publicPriceCeiling: 3000, publicAuditRetries: 4 } },
        ],
      };
    }
    throw new Error("unexpected stage " + request.stage);
  }
}

class StaleRejectedCommercialPlanner implements Planner {
  private commercialCalls = 0;
  calls: PlanningStage[] = [];
  async generateStage(request: PlannerRequest): Promise<PlanningStageOutput> {
    this.calls.push(request.stage);
    if (request.stage === "basicInfo") return { reply: "basic", modules: [{ module: "basicInfo", status: "accepted", value: { subtitle: "太原精华之旅", province: "山西", operationNotes: "待核查" } }] };
    if (request.stage === "itinerary") {
      return {
        reply: "itin",
        modules: [{ module: "itinerary", status: "accepted", value: [
          { day: 1, title: "D1", spots: [{ name: "晋祠", poiName: null, poiId: null }], description: "D", hotel: "H", meals: "B/L/D" },
          { day: 2, title: "D2", spots: [{ name: "山西博物院", poiName: null, poiId: null }], description: "D", hotel: "", meals: "B/L/D" },
        ] }],
      };
    }
    if (request.stage === "presentation") {
      return {
        reply: "pres",
        modules: [{ module: "presentation", status: "accepted", value: {
          recommendationCategory: "优选行程", recommendation: "R",
          recommendations: [
            { category: "优选行程", text: "a" }, { category: "精选酒店", text: "b" }, { category: "缤纷景点", text: "c" },
          ],
          features: "f",
        } }],
      };
    }
    if (request.stage === "commercial") {
      this.commercialCalls += 1;
      if (this.commercialCalls === 1) {
        return {
          reply: "com",
          modules: [
            { module: "pricing", status: "accepted", value: { currency: "CNY", adult: 1000, child: 500, minimumTravelers: 2 } },
            { module: "inventory", status: "accepted", value: { startDate: "2026-08-10", endDate: "2026-12-31", dailyQuota: 6 } },
            { module: "release", status: "accepted", value: { submitReview: false, publishAfterApproval: false, publicPriceCeiling: 3000, publicAuditRetries: 4 } },
            { module: "inventory", status: "rejected", reason: "第一轮库存格式不合规" },
          ],
        };
      }
      return {
        reply: "com-retry",
        modules: [
          { module: "inventory", status: "accepted", value: { startDate: "2026-08-10", endDate: "2026-12-31", dailyQuota: 6 } },
        ],
      };
    }
    throw new Error("unexpected stage " + request.stage);
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
    const segs = path.split("/").slice(1);
    const next = structuredClone(this.product) as Record<string, unknown>;
    let parent = next;
    for (let i = 0; i < segs.length - 1; i += 1) parent = (parent[segs[i]] ??= {}) as Record<string, unknown>;
    parent[segs.at(-1)!] = value;
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

test("commercial 阶段首轮只 partial accepted → needs_user；resume 后 partial 不被覆盖", async () => {
  const store = new InMemoryStore();
  const rt = new FakeRuntime();
  const p1 = new PartialCommercialPlanner("first");
  const r1 = await runPlan({
    localProductId: "p", skeleton, store, runtime: rt, planner: p1, providerLabel: "minimax",
    options: { stageRetryLimit: 1 },
  });
  // 状态应当进 needs_user：缺 inventory / release。
  assert.equal(r1.status, "needs_user");
  const rejected1 = r1.rejected.map((m) => m.module).sort();
  assert.ok(rejected1.includes("inventory"));
  assert.ok(rejected1.includes("release"));
  // packageName 由本地规则生成，pricing 由 AI 落地。
  const c = rt.product.commercial as Record<string, unknown>;
  assert.equal(c.packageName, "太原2天1晚私家团");
  assert.equal((c.pricing as { adult: number }).adult, 1000);

  // 第二次 resume：用 second-mode planner 补齐剩余模块。
  const p2 = new PartialCommercialPlanner("second");
  const r2 = await runPlan({
    localProductId: "p", skeleton, store, runtime: rt, planner: p2, providerLabel: "minimax",
    options: { stageRetryLimit: 1 },
  });
  assert.equal(r2.status, "completed");
  // 已被接受的 packageName / pricing 仍保留原值。
  const c2 = rt.product.commercial as Record<string, unknown>;
  assert.equal(c2.packageName, "太原2天1晚私家团", "resume 不应覆盖 packageName");
  assert.equal((c2.pricing as { adult: number }).adult, 1000, "resume 不应覆盖 pricing");
  // 两个新模块已落地；terms 不属于 AI planning。
  assert.ok(c2.inventory);
  assert.ok(c2.release);
  assert.equal((c2.release as { submitReview: boolean }).submitReview, false);
});

test("commercial 阶段 partial 提交：accepted 模块不会被后续 retry 的输出覆盖", async () => {
  const store = new InMemoryStore();
  const rt = new FakeRuntime();
  // 第一轮给全部 4 个 planning commercial 模块（packageName 由本地生成）。
  const p1 = new PartialCommercialPlanner("first");
  await runPlan({ localProductId: "p", skeleton, store, runtime: rt, planner: p1, providerLabel: "minimax", options: { stageRetryLimit: 1 } });
  const before = (rt.product.commercial as Record<string, unknown>).packageName;
  // resume 触发：second planner 不会重发 packageName（它已经 accepted），应当只补缺失。
  const p2 = new PartialCommercialPlanner("second");
  await runPlan({ localProductId: "p", skeleton, store, runtime: rt, planner: p2, providerLabel: "minimax", options: { stageRetryLimit: 1 } });
  const after = (rt.product.commercial as Record<string, unknown>).packageName;
  assert.equal(after, before, "packageName 不被 resume 覆盖");
});

test("commercial 阶段本地生成 packageName，摘要不显示已修复旧拒绝", async () => {
  const store = new InMemoryStore();
  const rt = new FakeRuntime();
  const planner = new StaleRejectedCommercialPlanner();
  const result = await runPlan({
    localProductId: "p", skeleton, store, runtime: rt, planner, providerLabel: "minimax",
    options: { stageRetryLimit: 2 },
  });

  assert.equal(result.status, "completed");
  assert.deepEqual(result.rejected.map((m) => m.module), []);
  assert.ok(!result.assistantReply.includes("inventory（第一轮库存格式不合规）"));

  const commercialStage = store.state?.stages.find((stage) => stage.stage === "commercial");
  assert.deepEqual(commercialStage?.rejected.map((m) => m.module), []);
  assert.equal(commercialStage?.accepted.filter((m) => m.module === "packageName").length, 1);
  assert.equal(commercialStage?.accepted.filter((m) => m.module === "inventory").length, 1);
});
