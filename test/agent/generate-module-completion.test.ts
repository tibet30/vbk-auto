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

test("generate_product_module 的 presentation 模型失败时如实失败，不写本地兜底图文", async () => {
  let saved = commercialDraft();
  saved.product.presentation = undefined;
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
    resourceQueries: { recommendationCategoryPolicy: async () => ({
      source: "fixed-replay", inputLocale: "zh-CN", productPatternId: 4, limited: true,
      categoryIds: [1, 2, 3, 5, 15], categories: ["服务保障", "贴心赠送", "精选酒店", "特色美食", "缤纷体验"],
      fetchedAt: "2026-10-16T00:00:00.000Z",
    }) },
    generateStage: async () => { throw new Error("模型未通过结构化工具返回本阶段模块。"); },
    disambiguatePoiOption: async () => ({ pickedText: null, confidence: 0 }),
    disambiguateStationOption: async () => ({ pickedText: null, reasoning: "" }),
    emitProduct: () => undefined,
  });
  const tool = tools.find((item) => item.name === "generate_product_module");
  assert.ok(tool);
  await assert.rejects(tool!.execute({ stage: "presentation" }, { localProductId: saved.id, accountKey: "a", productVersion: "v" }),
    /模型未通过结构化工具返回本阶段模块/);
  assert.equal(saved.product.presentation?.recommendations, undefined, "不得写入本地兜底推荐理由");
});

const VAGUE = [
  { category: "服务保障", text: "行程安排清晰，游览节奏舒适，各环节衔接明确无需操心" },
  { category: "精选酒店", text: "住宿安排舒适方便每日出行，整体体验更加轻松愉快" },
  { category: "缤纷体验", text: "串联当地景点，兼顾风光与人文，内容丰富值得体验" },
];
const CONCRETE = [
  { category: "服务保障", text: "成都2天专车接送，宽窄巷子到武侯祠全程同一司机衔接" },
  { category: "精选酒店", text: "成都市区酒店连住1晚，含双早，步行可达春熙路商圈" },
  { category: "缤纷体验", text: "武侯祠读三国典故，宽窄巷子逛老成都街巷，半日一处不赶路" },
];
const POLICY = async () => ({ source: "fixed-replay" as const, inputLocale: "zh-CN", productPatternId: 4, limited: true,
  categoryIds: [1, 2, 3, 5, 15], categories: ["服务保障", "贴心赠送", "精选酒店", "特色美食", "缤纷体验"], fetchedAt: "2026-10-16T00:00:00.000Z" });

function presentationTools(saved: { current: ProductDetail }, generateStage: (...args: any[]) => Promise<any>) {
  const store = {
    getProduct: () => saved.current,
    updateProduct: (_id: string, product: Record<string, unknown>, status?: ProductSummary["status"]) => {
      saved.current = { ...saved.current, product, status: status ?? saved.current.status };
    },
    getSetting: () => undefined, addResearchTask: () => "task",
  };
  return createAgentBusinessTools({
    db: store as any, browser: {} as any, automation: {} as any,
    productWorkflows: { runExclusive: async (_id: string, _k: string, work: () => Promise<unknown>) => work(),
      runVbkPageExclusive: async <T>(work: () => Promise<T>) => work() } as any,
    productMutations: new ProductMutationService(store), resourceQueries: { recommendationCategoryPolicy: POLICY },
    generateStage, disambiguatePoiOption: async () => ({ pickedText: null, confidence: 0 }),
    disambiguateStationOption: async () => ({ pickedText: null, reasoning: "" }), emitProduct: () => undefined,
  });
}
const ctx = (saved: { current: ProductDetail }) => ({ localProductId: saved.current.id, accountKey: "a", productVersion: "v" });

test("patch_product 写入空泛推荐理由被拒绝并返回逐条原因", async () => {
  const saved = { current: commercialDraft() };
  const tool = presentationTools(saved, async () => ({ reply: "", modules: [] })).find((item) => item.name === "patch_product")!;
  await assert.rejects(tool.execute({ patch: { presentation: { recommendations: VAGUE } } }, ctx(saved)),
    /推荐理由不够具体，未保存：第1条缺少具体景点名或数字；第2条缺少具体景点名或数字；第3条缺少具体景点名或数字/);
  assert.notDeepEqual((saved.current.product.presentation as { recommendations?: unknown })?.recommendations, VAGUE);
});

test("已保存空泛推荐理由时 ensure_presentation_recommendations 不算已完成，而是重新生成", async () => {
  const saved = { current: commercialDraft() };
  saved.current.product.presentation = { recommendationCategory: "服务保障", recommendation: "成都两日", features: "<p>成都</p>", recommendations: VAGUE } as never;
  let calls = 0;
  const tool = presentationTools(saved, async () => { calls += 1; throw new Error("模型未返回图文"); })
    .find((item) => item.name === "ensure_presentation_recommendations")!;
  await assert.rejects(tool.execute({}, ctx(saved)), /模型未返回图文/);
  assert.equal(calls, 1, "空泛推荐理由不得被判为 alreadySatisfied");
});

test("第二次生成调用收到第一次的拒绝原因作为 previousError", async () => {
  const saved = { current: commercialDraft() };
  saved.current.product.presentation = undefined;
  const seen: Array<{ message: string } | undefined> = [];
  const outputs = [VAGUE, CONCRETE];
  const tool = presentationTools(saved, async (_id: string, _stage: string, previousError?: { message: string }) => {
    seen.push(previousError);
    return { reply: "", modules: [{ module: "presentation", status: "accepted", value: {
      recommendationCategory: "服务保障", recommendation: "成都2天串联宽窄巷子与武侯祠", features: "<p>成都老城街巷与三国祠堂。</p>",
      recommendations: outputs.shift() } }] };
  }).find((item) => item.name === "generate_product_module")!;
  await assert.rejects(tool.execute({ stage: "presentation" }, ctx(saved)), /推荐理由不够具体：第1条缺少具体景点名或数字/);
  await tool.execute({ stage: "presentation" }, ctx(saved));
  assert.equal(seen[0], undefined);
  assert.match(seen[1]?.message ?? "", /推荐理由不够具体：第1条缺少具体景点名或数字/);
});
