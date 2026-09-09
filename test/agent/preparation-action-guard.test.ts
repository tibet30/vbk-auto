import assert from "node:assert/strict";
import test from "node:test";
import { buildProductSnapshot } from "../../src/main/infrastructure/database/parts/product-draft.js";
import { denyPreparationTool } from "../../src/main/agent/preparation-action-guard.js";
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

test("itinerary 未完成时不能通过 commercial 或封面绕过", () => {
  const product = itineraryProduct();
  assert.equal(denyPreparationTool(product, undefined, "generate_product_module", { stage: "itinerary" }), undefined);
  assert.equal(denyPreparationTool(product, undefined, "query_poi", { keyword: "宽窄巷子" }), undefined);
  const commercial = denyPreparationTool(product, undefined, "generate_product_module", { stage: "commercial" });
  assert.ok(commercial);
  const payload = JSON.parse(commercial.content);
  assert.equal(payload.currentStage, "itinerary");
  assert.deepEqual(payload.missing, commercial.data.missing);
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
