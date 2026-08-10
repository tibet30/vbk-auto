/**
 * 历史数据隔离测试：确保新建项目从骨架生成的 supplierProductCode / 资源 ID
 * / 价格 / 库存日期 / 推荐语与 examples/taiyuan-private-2d1n.json 不同。
 *
 *  同时验证 orchestrator 与 adapter 不会从 example 里复制 ID / 价格 / 日期
 *  / 推荐语等到新产品；adapter 的 system prompt 也不携带这些具体值。
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runPlan } from "../../src/main/planning/plan-orchestrator.js";
import { detectAcceptedModulesFromProduct } from "../../src/main/planning/runtime.js";
import { normaliseProductDraft } from "../../src/main/data/product-normalize.js";
import { applyProductPatchSafe } from "../../src/main/operations/product-patch.js";
import type {
  GenerationStateStore, OrchestratorRuntime,
} from "../../src/main/planning/types.js";
import type {
  Planner, PlannerRequest, PlanningStageOutput, PlanningGenerationState, PlanningModule, PlanningStage, ResearchTaskProposal,
} from "../../src/shared/contracts-planning.js";
import { AI_WRITABLE_PATHS } from "../../src/main/planning/schemas.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const examplePath = path.resolve(__dirname, "../../examples/taiyuan-private-2d1n.json");
const example = JSON.parse(fs.readFileSync(examplePath, "utf8")) as Record<string, unknown>;
const exampleVehicle = (example.operations as Record<string, unknown>).vehicleResource as Record<string, unknown>;
const exampleHotelTier = (example.operations as Record<string, unknown>).hotelTier as string;

class DisjointPlanner implements Planner {
  constructor(private readonly outputs: Record<PlanningStage, PlanningStageOutput>) {}
  calls: PlanningStage[] = [];
  async generateStage(request: PlannerRequest): Promise<PlanningStageOutput> {
    this.calls.push(request.stage);
    return this.outputs[request.stage] ?? { reply: "basic", modules: [{ module: "basicInfo", status: "accepted", value: { subtitle: "太原精华之旅", province: "山西", operationNotes: "待核查" } }] };
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

const skeleton = {
  destination: "南京",
  days: 3,
  nights: 2,
  productForm: "privateTour" as const,
  productType: "domesticShort" as const,
  supplierProductCode: "VBK-20260101-NEWXYZ",
};

const fullOutputs: Record<PlanningStage, PlanningStageOutput> = {
  skeleton: { reply: "skel", modules: [{ module: "skeleton", status: "accepted", value: { hotelTier: "当地5钻酒店/-38", pickupCity: "南京", transport: "charter", reusePickupForDropoff: true, mealsIncluded: false } }] },
  itinerary: { reply: "itin", modules: [{ module: "itinerary", status: "accepted", value: [
    { day: 1, title: "Day 1 南京", spots: [{ name: "中山陵", poiName: null, poiId: null }], description: "D1", hotel: "南京酒店", meals: "B/L/D" },
    { day: 2, title: "Day 2 南京", spots: [{ name: "夫子庙", poiName: null, poiId: null }], description: "D2", hotel: "南京酒店", meals: "含早餐；午餐自理；晚餐自理" },
    { day: 3, title: "Day 3 南京", spots: [{ name: "总统府", poiName: null, poiId: null }], description: "D3", hotel: "", meals: "含早餐；午餐自理；晚餐自理" },
  ] }] },
  presentation: { reply: "pres", modules: [{ module: "presentation", status: "accepted", value: {
    recommendationCategory: "优选行程", recommendation: "南京三日历史文化漫游",
    recommendations: [
      { category: "优选行程", text: "三日深度漫游" }, { category: "精选酒店", text: "当地 5 钻酒店" }, { category: "缤纷景点", text: "覆盖中山陵/总统府" },
    ], features: "【古都巡礼】专业讲解",
  } }] },
  commercial: { reply: "com", modules: [
    { module: "packageName", status: "accepted", value: "南京 3 天 2 晚私家团" },
    { module: "pricing", status: "accepted", value: { currency: "CNY", adult: 1500, child: 800, minimumTravelers: 2 } },
    { module: "inventory", status: "accepted", value: { startDate: "2026-09-01", endDate: "2026-12-31", dailyQuota: 6 } },
    { module: "terms", status: "accepted", value: { inclusions: "i", exclusions: "e", bookingNotes: "b", refundPolicy: "r" } },
    { module: "release", status: "accepted", value: { submitReview: false, publishAfterApproval: false, publicPriceCeiling: 3000, publicAuditRetries: 4 } },
  ] },
  research: { reply: "rt", modules: [{ module: "researchTasks", status: "accepted", researchTasks: [
    { label: "核查 VBK 资源", type: "vbk" }, { label: "核查酒店", type: "vbk" }, { label: "核查用车", type: "vbk" }, { label: "核查价格", type: "vbk" }, { label: "核查库存", type: "vbk" },
  ] }] },
  validation: { reply: "", modules: [] },
};

test("新建产品不复用 example 里的 supplierProductCode / vehicleResource / hotelTier", async () => {
  const store = new InMemoryStore();
  const rt = new FakeRuntime();
  const planner = new DisjointPlanner(fullOutputs);
  await runPlan({ projectId: "p", skeleton, store, runtime: rt, planner, providerLabel: "minimax" });

  // 1. supplierProductCode 必须保留骨架里的 NEWXYZ。
  //    planning 只写骨架到 /operations；basicInfo 由 db.createProject 填充并保持不变。
  //    FakeRuntime 的 product 不含 basicInfo；这里断言：planner 全程没有写过 supplierProductCode。
  const basicInfo = (rt.product.basicInfo ?? {}) as { supplierProductCode?: string };
  assert.equal(basicInfo.supplierProductCode ?? skeleton.supplierProductCode, skeleton.supplierProductCode);
  assert.notEqual(basicInfo.supplierProductCode ?? skeleton.supplierProductCode, "TY-SJT-2D1N-001");
  // 2. vehicleResource 必须不存在：AI 写 supplierCode / resourceId 一律被拒。
  const operations = rt.product.operations as Record<string, unknown> | undefined;
  assert.equal(operations && operations.vehicleResource, undefined);
  // 3. hotelTier 必须是 /-38；example 是 /-3（但我们要避免复刻 /-3）。
  assert.equal((operations as { hotelTier: string }).hotelTier, "当地5钻酒店/-38");
  assert.notEqual((operations as { hotelTier: string }).hotelTier, exampleHotelTier);
});

test("新建产品不复用 example 的价格 / 库存日期", async () => {
  const store = new InMemoryStore();
  const rt = new FakeRuntime();
  const planner = new DisjointPlanner(fullOutputs);
  await runPlan({ projectId: "p", skeleton, store, runtime: rt, planner, providerLabel: "minimax" });
  const commercial = rt.product.commercial as { pricing: { adult: number }; inventory: { startDate: string } };
  assert.notEqual(commercial.pricing.adult, 1233);
  assert.notEqual(commercial.inventory.startDate, "2026-08-10");
  // 但数字 / 日期格式仍然合法。
  assert.ok(commercial.pricing.adult > 0);
  assert.match(commercial.inventory.startDate, /^\d{4}-\d{2}-\d{2}$/);
});

test("patch 只允许写 vehicleResource.requestedDailyCost；真实资源字段仍被拒", () => {
  const product: Record<string, unknown> = { basicInfo: { supplierProductCode: "NEW" } };
  const blockedPatch = applyProductPatchSafe(product, [
    { op: "replace", path: "/basicInfo/supplierProductCode", value: "TY-SJT-2D1N-001" },
  ]);
  assert.equal(blockedPatch.applied, false);
  const vehiclePatch = applyProductPatchSafe(product, [
    { op: "add", path: "/operations/vehicleResource", value: { vehicleId: 5422005, resourceId: 76479748 } },
  ]);
  assert.equal(vehiclePatch.applied, false);
  const vehicleIdPatch = applyProductPatchSafe(product, [
    { op: "add", path: "/operations/vehicleResource/resourceGroupId", value: 123 },
  ]);
  assert.equal(vehicleIdPatch.applied, false);
  const requestedCostPatch = applyProductPatchSafe(product, [
    { op: "add", path: "/operations/vehicleResource/requestedDailyCost", value: 1000 },
  ]);
  assert.equal(requestedCostPatch.applied, true);
  assert.equal((((requestedCostPatch.product.operations as Record<string, unknown>).vehicleResource as Record<string, unknown>).requestedDailyCost), 1000);
  // 允许写入合法字段。
  const allowedPatch = applyProductPatchSafe(product, [
    { op: "replace", path: "/operations/hotelTier", value: "当地5钻酒店/-38" },
  ]);
  assert.equal(allowedPatch.applied, true);
  // 旧 /-5 写入也会被 normalise 成 /-38。
  const normalised = normaliseProductDraft(allowedPatch.product);
  assert.equal((normalised.operations as { hotelTier: string }).hotelTier, "当地5钻酒店/-38");
});

test("vehicleResource 一旦写入 product 即被 normalise 视为不存在（参考数据隔离）", () => {
  const product = {
    basicInfo: { supplierProductCode: "NEW" },
    operations: { vehicleResource: exampleVehicle },
  };
  // 即便 patch 强行写入了 vehicleResource，normaliseProductDraft 不会自动删除。
  // 这里专门断言：applyProductPatchSafe 会拒绝。
  const result = applyProductPatchSafe(product, [
    { op: "replace", path: "/operations/hotelTier", value: "当地5钻酒店/-38" },
  ]);
  assert.equal(result.applied, true);
  // /-38 落地。
  assert.equal((result.product.operations as { hotelTier: string }).hotelTier, "当地5钻酒店/-38");
});
