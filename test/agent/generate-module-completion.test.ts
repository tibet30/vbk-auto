import assert from "node:assert/strict";
import test from "node:test";
import { buildProductSnapshot } from "../../src/main/infrastructure/database/parts/product-draft.js";
import { createAgentBusinessTools } from "../../src/main/agent/integration.js";
import { applyStageDeterministicCompletion, skeletonFromProduct } from "../../src/main/planning/stage-deterministic-completion.js";
import { detectAcceptedModulesFromProduct } from "../../src/main/planning/runtime.js";
import { AI_WRITABLE_PATHS } from "../../src/main/planning/schemas.js";
import { ProductMutationService } from "../../src/main/application/product-mutation-service.js";
import type { OrchestratorRuntime } from "../../src/main/planning/types.js";
import type { PlanningModule } from "../../src/shared/contracts-planning.js";
import type { ProductDetail, ProductSummary } from "../../src/shared/contracts.js";

class FakeRuntime implements OrchestratorRuntime {
  constructor(public product: Record<string, unknown>) {}
  async loadExistingResearchTasks() { return []; }
  async writeModule(_id: string, _module: PlanningModule, path: string, value: unknown) {
    const segs = path.split("/").slice(1);
    const next = structuredClone(this.product) as Record<string, unknown>;
    let parent = next;
    for (let index = 0; index < segs.length - 1; index += 1) {
      parent = (parent[segs[index]!] ??= {}) as Record<string, unknown>;
    }
    parent[segs.at(-1)!] = value;
    this.product = next;
    return { ok: true };
  }
  async addResearchTask() { return "id"; }
  async loadHistory() { return []; }
  async loadCurrentProduct() { return this.product; }
  async loadAcceptedModules() { return detectAcceptedModulesFromProduct(this.product); }
}

function commercialDraft(): ProductDetail {
  const product = buildProductSnapshot({ destination: "成都", days: 2, productForm: "privateTour" });
  Object.assign(product.product.basicInfo!, { subtitle: "成都两日", province: "四川", operationNotes: "按约定行程安排" });
  Object.assign(product.product.operations!, { pickupCity: "成都", hotelTier: "当地4钻酒店/-4", transport: "charter" });
  product.product.itinerary = [
    { day: 1, title: "宽窄巷子", description: "讲解宽窄巷子", hotel: "无", meals: "自理", spots: [{ name: "宽窄巷子", poiName: "宽窄巷子", poiId: 101 }] },
    { day: 2, title: "武侯祠", description: "游览武侯祠", hotel: "无", meals: "自理", spots: [{ name: "武侯祠", poiName: "武侯祠", poiId: 102 }] },
  ];
  product.product.commercial = {};
  return product;
}

test("阶段三确定性补全会写入套餐名和商业 fallback，且不覆盖人工选择", async () => {
  const runtime = new FakeRuntime(commercialDraft().product);
  const first = await applyStageDeterministicCompletion({
    stage: "commercial",
    localProductId: "p",
    skeleton: skeletonFromProduct(runtime.product),
    runtime,
  });
  assert.ok(first.accepted.some((item) => item.module === "packageName"));
  assert.ok(first.accepted.some((item) => item.module === "pricing"));
  const commercial = runtime.product.commercial as Record<string, unknown>;
  assert.equal(commercial.packageName, "成都2天1晚私家团");
  const adult = (commercial.pricing as { adult: number }).adult;
  assert.ok(adult > 0);
  assert.ok(commercial.inventory);

  (runtime.product.commercial as Record<string, unknown>).packageName = "人工定制套餐";
  (runtime.product.commercial as Record<string, unknown>).pricing = {
    currency: "CNY", adult: 2880, child: 1280, minimumTravelers: 1,
    cost: { adult: 2000, child: 900, singleSupplement: 0, childBed: 0 },
  };
  const second = await applyStageDeterministicCompletion({
    stage: "commercial",
    localProductId: "p",
    skeleton: skeletonFromProduct(runtime.product),
    runtime,
  });
  assert.equal((runtime.product.commercial as { packageName: string }).packageName, "人工定制套餐");
  assert.equal((runtime.product.commercial as { pricing: { adult: number } }).pricing.adult, 2880);
  assert.ok(!second.accepted.some((item) => item.module === "packageName" || item.module === "pricing"));
});

test("generate_product_module 的 commercial 路径会执行确定性商业补全", async () => {
  let saved = commercialDraft();
  const store = {
    getProduct: () => saved,
    updateProduct: (_id: string, product: Record<string, unknown>, status?: ProductSummary["status"]) => {
      saved = { ...saved, product, status: status ?? saved.status };
    },
    getSetting: () => undefined,
    addResearchTask: () => "task",
  };
  const tools = createAgentBusinessTools({
    db: store as any,
    browser: {} as any,
    automation: {} as any,
    productWorkflows: {
      runExclusive: async (_id: string, _kind: string, work: () => Promise<unknown>) => work(),
      runVbkPageExclusive: async <T>(work: () => Promise<T>) => work(),
    } as any,
    productMutations: new ProductMutationService(store),
    generateStage: async () => ({ reply: "ok", modules: [] }),
    disambiguatePoiOption: async () => ({ pickedText: null, confidence: 0 }),
    disambiguateStationOption: async () => ({ pickedText: null, reasoning: "" }),
    emitProduct: () => undefined,
  });
  const tool = tools.find((item) => item.name === "generate_product_module");
  assert.ok(tool);
  const result = await tool!.execute({ stage: "commercial" }, { localProductId: saved.id, accountKey: "a", productVersion: "v" });
  const payload = JSON.parse(result.content) as { accepted: Array<{ module: string }> };
  assert.ok(payload.accepted.some((item) => item.module === "packageName"));
  assert.ok(payload.accepted.some((item) => item.module === "pricing"));
  assert.equal((payload as { pricingSemantics?: string }).pricingSemantics, "localReviewDraft");
  assert.equal((saved.product.commercial as { packageName: string }).packageName, "成都2天1晚私家团");
  assert.ok(((saved.product.commercial as { pricing: { adult: number } }).pricing.adult) > 0);
  assert.ok((saved.product.commercial as { inventory?: unknown }).inventory);
  assert.equal(AI_WRITABLE_PATHS.packageName, "/commercial/packageName");
});
