import assert from "node:assert/strict";
import test from "node:test";
import { createAgentBusinessTools } from "../../src/main/agent/integration.js";
import { ProductMutationService } from "../../src/main/application/product-mutation-service.js";
import { buildProductSnapshot } from "../../src/main/infrastructure/database/parts/product-draft.js";
import { evaluatePreparationCompletion } from "../../src/main/planning/preparation-completion.js";
import type { ProductSummary } from "../../src/shared/contracts.js";

function product() {
  const saved = buildProductSnapshot({ destination: "成都", days: 2, productForm: "privateTour" });
  Object.assign(saved.product.basicInfo!, { province: "四川", subtitle: "成都两日游", operationNotes: "按约定行程" });
  Object.assign(saved.product.operations!, { pickupCity: "成都", hotelTier: "当地4钻酒店/-4", transport: "charter" });
  saved.product.itinerary = [{ day: 1, title: "原行程", description: "保留原行程", hotel: "无", meals: "自理",
    spots: [{ name: "宽窄巷子", poiName: "宽窄巷子", poiId: 101 }] }];
  return saved;
}

function toolsFor(output: unknown, options: { persistWrites?: boolean } = {}) {
  let saved = product();
  const store = {
    getProduct: () => saved,
    updateProduct: (_id: string, next: Record<string, unknown>, status?: ProductSummary["status"]) => {
      if (options.persistWrites === false) return;
      saved = { ...saved, product: next, status: status ?? saved.status };
    },
    getSetting: () => undefined,
    addResearchTask: () => "task",
    markResearchTasksSatisfied: () => undefined,
    reopenKindSupersededPoiResearchTasks: () => undefined,
    markResearchTasksSatisfiedByProduct: () => ({ updated: 0, taskIds: [] }),
  };
  const tools = createAgentBusinessTools({
    db: store as never, browser: { requestPage: async () => ({
      evaluate: async () => { throw new Error("测试未提供可验证的远端资源"); },
    }) } as never, automation: {} as never,
    productWorkflows: { runExclusive: async (_id: string, _kind: string, work: () => Promise<unknown>) => work(),
      runVbkPageExclusive: async <T>(work: () => Promise<T>) => work() } as never,
    productMutations: new ProductMutationService(store),
    generateStage: async () => output as never,
    disambiguatePoiOption: async () => ({ pickedText: null, confidence: 0 }),
    disambiguateStationOption: async () => ({ pickedText: null, reasoning: "" }), emitProduct: () => undefined,
  });
  return { saved: () => saved, tool: tools.find((item) => item.name === "generate_product_module")! };
}

test("rejected itinerary generation throws and preserves the existing itinerary", async () => {
  const { saved, tool } = toolsFor({ reply: "invalid", modules: [{ module: "itinerary", status: "rejected", reason: "锁定天数冲突" }] });
  await assert.rejects(() => tool.execute({ stage: "itinerary" }, { localProductId: saved().id, accountKey: "a", productVersion: "v" }), /锁定天数冲突/);
  assert.equal(saved().product.itinerary?.[0]?.title, "原行程");
});

test("accepted itinerary still fails when the persisted readback remains incomplete", async () => {
  const itinerary = [{ day: 1, title: "宽窄巷子", description: "游览宽窄巷子", hotel: "无", meals: "自理",
    spots: [{ name: "宽窄巷子" }] },
  { day: 2, title: "武侯祠", description: "游览武侯祠", hotel: "无", meals: "自理",
    spots: [{ name: "武侯祠" }] }];
  const { saved, tool } = toolsFor({ reply: "ok", modules: [{ module: "itinerary", status: "accepted", value: itinerary }] }, { persistWrites: false });
  await assert.rejects(() => tool.execute({ stage: "itinerary" }, { localProductId: saved().id, accountKey: "a", productVersion: "v" }), /写入后回读结构无效/);
  assert.equal(saved().product.itinerary?.length, 1);
});

test("accepted itinerary without verified POIs stays valid and moves to POI resolution", async () => {
  const itinerary = [{ day: 1, title: "宽窄巷子", description: "游览宽窄巷子", hotel: "无", meals: "自理",
    spots: [{ name: "宽窄巷子", poiName: "宽窄巷子", poiId: 101 }] },
  { day: 2, title: "武侯祠", description: "游览武侯祠", hotel: "无", meals: "自理",
    spots: [{ name: "武侯祠", poiName: "武侯祠", poiId: 102 }] }];
  const { saved, tool } = toolsFor({ reply: "ok", modules: [{ module: "itinerary", status: "accepted", value: itinerary }] });
  const result = await tool.execute({ stage: "itinerary" }, { localProductId: saved().id, accountKey: "a", productVersion: "v" });
  assert.match(result.content, /"itinerary"/);
  assert.equal(saved().product.itinerary?.[0]?.title, "宽窄巷子");
  assert.equal(saved().product.itinerary?.[0]?.spots?.[0]?.poiId, 101);
  assert.equal(saved().product.itinerary?.[1]?.spots?.[0]?.poiId, null);
  assert.equal(evaluatePreparationCompletion(saved()).currentNode, "poiResolution");
});
