import assert from "node:assert/strict";
import test from "node:test";
import { buildProductSnapshot } from "../../src/main/infrastructure/database/parts/product-draft.js";
import { denyPreparationTool } from "../../src/main/agent/preparation-action-guard.js";
import { evaluatePreparationCompletion } from "../../src/main/planning/preparation-completion.js";
import { createAgentBusinessTools } from "../../src/main/agent/integration.js";
import type { ProductDetail } from "../../src/shared/contracts.js";

function foundationProduct(): ProductDetail {
  const product = buildProductSnapshot({ destination: "成都", days: 2, productForm: "privateTour" });
  (product.product.basicInfo as Record<string, unknown>).days = 0;
  return product;
}

function itineraryProduct(): ProductDetail {
  const product = buildProductSnapshot({ destination: "成都", days: 2, productForm: "privateTour" });
  Object.assign(product.product.basicInfo!, { subtitle: "成都两日", province: "四川", operationNotes: "按约定行程安排" });
  Object.assign(product.product.operations!, { pickupCity: "成都", hotelTier: "当地5钻酒店/-38", transport: "charter" });
  product.product.itinerary = [
    { day: 1, title: "宽窄巷子", description: "游览", hotel: "无", meals: "自理", spots: [{ name: "宽窄巷子", poiName: null, poiId: null }] },
    { day: 2, title: "武侯祠", description: "游览", hotel: "无", meals: "自理", spots: [{ name: "武侯祠", poiName: null, poiId: null }] },
  ];
  product.researchTasks = [{
    id: "task-1", label: "宽窄巷子", type: "vbk", status: "running", state: "needs_confirmation", detail: "POI 未匹配，待人工确认",
  }];
  return product;
}

test("foundation 未完成时只能补基础，不能生成行程或商业模块", () => {
  const product = foundationProduct();
  assert.equal(denyPreparationTool(product, undefined, "read_product"), undefined);
  assert.equal(denyPreparationTool(product, undefined, "ask_user"), undefined);
  assert.equal(denyPreparationTool(product, undefined, "capture_itinerary_draft_save"), undefined);
  assert.equal(denyPreparationTool(product, undefined, "read_itinerary_draft_diagnostic"), undefined);
  assert.equal(denyPreparationTool(product, undefined, "generate_product_module", { stage: "basicInfo" }), undefined);
  const itinerary = denyPreparationTool(product, undefined, "generate_product_module", { stage: "itinerary" });
  assert.ok(itinerary);
  const payload = JSON.parse(itinerary.content);
  assert.equal(payload.currentStage, "foundation");
  assert.ok(Array.isArray(payload.missing));
  assert.ok(denyPreparationTool(product, undefined, "generate_product_module", { stage: "commercial" }));
  assert.ok(denyPreparationTool(product, undefined, "resolve_cover"));
  assert.ok(denyPreparationTool(product, undefined, "patch_product", { patch: { commercial: { packageName: "x" } } }));
});

test("准备完成后允许本地受控修订，但不允许重新生成模块", () => {
  const product = itineraryProduct();
  product.researchTasks = [];
  for (const day of product.product.itinerary!) {
    day.spots = day.spots?.map((spot) => ({ ...spot, poiName: spot.name, poiId: day.day })) ?? [];
  }
  (product.product.presentation as Record<string, unknown> | undefined) ??= {
    recommendation: "成都慢游", features: "专车衔接", recommendations: [
      { category: "优选行程", text: "一日或两日私家串联宽窄巷子与武侯祠，行程节奏清晰不赶路，体验成都文化" },
      { category: "精选酒店", text: "精选当地住宿衔接景点与餐饮，方便每日出行与休息，整体体验更舒适" },
      { category: "缤纷景点", text: "覆盖宽窄巷子与武侯祠等景点，兼顾美食与古建，城市漫游内容更丰富完整" },
    ], cover: { source: "ctripLibrary", imageId: 1, imageUrl: "https://example.test/cover.jpg", alternates: [{ imageId: 2, imageUrl: "https://example.test/second.jpg", poi: "武侯祠", poiId: 2 }], poi: "宽窄巷子", description: "横版封面" },
  };
  Object.assign(product.product.operations!, {
    vehicleResource: { resourceGroupId: 88, resourceGroupName: "成都5座商务车" },
    trafficLine: { enabled: false, variants: [] },
    bookingControls: { butler: { contactCardId: 1, displayName: "管家A", providerId: 100 } },
  });
  product.product.commercial = {
    packageName: "成都2天1晚私家团",
    pricing: { currency: "CNY", adult: 1880, child: 980, minimumTravelers: 1, cost: { adult: 1500, child: 700, singleSupplement: 0, childBed: 0 } },
    inventory: { startDate: "2026-09-01", endDate: "2027-09-01", dailyQuota: 30 },
    release: { submitReview: false, publishAfterApproval: false, publicPriceCeiling: 2500, publicAuditRetries: 3 },
  };
  assert.equal(evaluatePreparationCompletion(product).ready, true);
  const allowed = denyPreparationTool(product, undefined, "patch_product", { patch: { itinerary: [{ day: 1, description: "调整后的合规文案" }] } });
  assert.equal(allowed, undefined);
  assert.ok(denyPreparationTool(product, undefined, "generate_product_module", { stage: "itinerary" }));
});

test("itinerary 未完成时不能通过 commercial 或封面绕过", () => {
  const product = itineraryProduct();
  assert.equal(denyPreparationTool(product, undefined, "generate_product_module", { stage: "itinerary" }), undefined);
  assert.equal(denyPreparationTool(product, undefined, "query_poi", { keyword: "宽窄巷子" }), undefined);
  const commercial = denyPreparationTool(product, undefined, "generate_product_module", { stage: "commercial" });
  assert.ok(commercial);
  const payload = JSON.parse(commercial.content);
  assert.equal(payload.currentStage, "itinerary");
  assert.deepEqual(payload.missing, commercial.data.missing);
  assert.ok(payload.currentStageMissing.some((item: string) => /每日行程|POI|核查|景点/.test(item)));
  assert.ok(payload.laterStageMissing.some((item: string) => /封面|推荐|酒店候选/.test(item)));
  assert.doesNotMatch(payload.error.split("后续阶段待补")[0], /封面图/);
  assert.ok(denyPreparationTool(product, undefined, "resolve_cover"));
  assert.ok(denyPreparationTool(product, undefined, "ensure_presentation_recommendations"));
  assert.ok(denyPreparationTool(product, undefined, "patch_product", { patch: { commercial: { packageName: "x" } } }));
  assert.ok(denyPreparationTool(product, undefined, "request_approval"));
});

test("foundation 允许基础 operations 字段，但不能借 operations 写入第三阶段配置", () => {
  const product = foundationProduct();
  assert.equal(denyPreparationTool(product, undefined, "patch_product", {
    patch: { operations: { pickupCity: "成都", transport: "charter", hotelTier: "当地5钻酒店/-38" } },
  }), undefined);
  const traffic = denyPreparationTool(product, undefined, "patch_product", {
    patch: { operations: { pickupCity: "成都", trafficLine: { enabled: true, variants: ["flightRoundTrip"] } } },
  });
  assert.ok(traffic);
  assert.match(JSON.parse(traffic.content).error, /operations\.trafficLine/);
  const vehicle = denyPreparationTool(product, undefined, "patch_product", {
    patch: { operations: { vehicleResource: { requestedTotalCost: 100 } } },
  });
  assert.ok(vehicle);
  assert.match(JSON.parse(vehicle.content).error, /operations\.vehicleResource/);
  const hotelResource = denyPreparationTool(product, undefined, "patch_product", {
    patch: { operations: { hotelResource: { source: "ctrip", resourceName: "成都酒店" } } },
  });
  assert.ok(hotelResource);
  assert.match(JSON.parse(hotelResource.content).error, /operations\.hotelResource/);
});

test("itinerary 允许受控端点字段，但不能借 operations 绕过到 traffic/completion", () => {
  const product = itineraryProduct();
  assert.equal(denyPreparationTool(product, undefined, "patch_product", {
    patch: { operations: { trafficLine: { arrivalCity: "成都", departureCity: "拉萨" } } },
  }), undefined);
  assert.equal(denyPreparationTool(product, undefined, "patch_product", {
    patch: { itinerary: product.product.itinerary },
  }), undefined);
  const enabled = denyPreparationTool(product, undefined, "patch_product", {
    patch: { operations: { trafficLine: { enabled: true, variants: ["flightRoundTrip"] } } },
  });
  assert.ok(enabled);
  const payload = JSON.parse(enabled.content);
  assert.match(payload.error, /operations\.trafficLine\.enabled/);
  assert.match(payload.error, /operations\.trafficLine\.variants/);
  const availability = denyPreparationTool(product, undefined, "patch_product", {
    patch: { operations: { trafficLine: { availability: { availableVariants: ["flightRoundTrip"] } } } },
  });
  assert.ok(availability);
  assert.match(JSON.parse(availability.content).error, /operations\.trafficLine\.availability/);
  const vehicle = denyPreparationTool(product, undefined, "patch_product", {
    patch: { operations: { vehicleResource: { resourceGroupId: 1, resourceGroupName: "成都5座" } } },
  });
  assert.ok(vehicle);
  assert.match(JSON.parse(vehicle.content).error, /operations\.vehicleResource/);
});

test("工具拒绝时通过 createAgentBusinessTools 返回 currentStage/currentNode/missing", async () => {
  const product = itineraryProduct();
  const tools = createAgentBusinessTools({
    db: { getProduct: () => product, getAgentSnapshot: () => undefined } as any,
    browser: {} as any,
    automation: {} as any,
    productWorkflows: {
      runExclusive: async (_id: string, _kind: string, work: () => Promise<unknown>) => work(),
      runVbkPageExclusive: async <T>(work: () => Promise<T>) => work(),
    } as any,
    productMutations: { applyAiPatch: () => ({ applied: true, product }) } as any,
    generateStage: async () => ({ reply: "ok", modules: [] }),
    disambiguatePoiOption: async () => ({ pickedText: null, confidence: 0 }),
    disambiguateStationOption: async () => ({ pickedText: null, reasoning: "" }),
    emitProduct: () => undefined,
  });
  const generate = tools.find((item) => item.name === "generate_product_module");
  const read = tools.find((item) => item.name === "read_product");
  assert.ok(generate && read);
  const denied = await generate.execute({ stage: "commercial" }, { localProductId: product.id, accountKey: "a", productVersion: "v" });
  const payload = JSON.parse(denied.content);
  assert.equal(payload.ok, false);
  assert.equal(payload.currentStage, "itinerary");
  assert.ok(payload.currentNode);
  assert.ok(Array.isArray(payload.missing));
  assert.equal(denied.data?.preparationDenied, true);
  const allowed = await read.execute({}, { localProductId: product.id, accountKey: "a", productVersion: "v" });
  assert.doesNotMatch(allowed.content, /preparationDenied/);
});
