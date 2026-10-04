import assert from "node:assert/strict";
import test from "node:test";
import { buildProductSnapshot } from "../../src/main/infrastructure/database/parts/product-draft.js";
import { decidePreparationAction } from "../../src/main/agent/preparation-director.js";
import { evaluatePreparationCompletion } from "../../src/main/planning/preparation-completion.js";

function product() {
  const value = buildProductSnapshot({ destination: "潮州", days: 2, productForm: "privateTour" });
  Object.assign(value.product.basicInfo!, { province: "广东", subtitle: "潮州两日私家团", operationNotes: "按用户日程安排" });
  Object.assign(value.product.operations!, { pickupCity: "潮州", transport: "charter" });
  return value;
}

test("缺少行程结构时优先生成，不因旧 POI research task 重复 resolve", () => {
  const value = product();
  value.researchTasks = [{
    id: "old-poi", label: "核查 南澳大桥 的 VBK POI 映射", type: "vbk", state: "researching", status: "queued", evidence: [],
  }];

  const evaluation = evaluatePreparationCompletion(value);
  assert.equal(evaluation.currentNode, "itineraryDraft");
  assert.deepEqual(decidePreparationAction(value), {
    node: "itineraryDraft",
    name: "generate_product_module",
    arguments: { stage: "itinerary" },
    progressKey: decidePreparationAction(value)!.progressKey,
  });
});

test("已有逐日结构而 POI 未核验时才进入 resolve", () => {
  const value = product();
  value.product.itinerary = [
    { day: 1, title: "潮州古城", description: "游览广济桥", hotel: "无", meals: "自理", spots: [{ name: "广济桥", poiName: null, poiId: null }] },
    { day: 2, title: "南澳海岸", description: "游览南澳大桥", hotel: "无", meals: "自理", spots: [{ name: "南澳大桥", poiName: null, poiId: null }] },
  ];
  value.researchTasks = [{
    id: "poi", label: "核查 南澳大桥 的 VBK POI 映射", type: "vbk", state: "researching", status: "queued", evidence: [],
  }];

  assert.equal(evaluatePreparationCompletion(value).currentNode, "poiResolution");
  assert.equal(decidePreparationAction(value)?.name, "resolve_itinerary_pois");
});

test("没有 research task 时，完整结构中的空 POI 仍进入 resolve", () => {
  const value = product();
  value.product.itinerary = [
    { day: 1, title: "潮州古城", description: "游览广济桥", hotel: "无", meals: "自理", spots: [{ name: "广济桥", poiName: null, poiId: null }] },
    { day: 2, title: "南澳海岸", description: "游览南澳大桥", hotel: "无", meals: "自理", spots: [{ name: "南澳大桥", poiName: null, poiId: null }] },
  ];

  assert.equal(evaluatePreparationCompletion(value).currentNode, "poiResolution");
  assert.equal(decidePreparationAction(value)?.name, "resolve_itinerary_pois");
});

test("酒店候选 schema 路径错误进入酒店 resolve，不被 POI 节点挡住", () => {
  const value = product();
  value.product.operations!.hotelTier = "当地5钻酒店/-38";
  value.product.itinerary = [
    { day: 1, title: "潮州古城", description: "游览广济桥", hotel: "潮州5钻酒店", meals: "自理", spots: [{ name: "广济桥", poiName: "广济桥", poiId: 101 }], hotelCandidates: [
      { hotelId: "101", hotelName: "错误 ID 酒店", diamond: 5, score: 4.8, distanceKm: 1, cityName: "潮州", anchorName: "广济桥", anchorCityId: 445 },
      { hotelId: 102, hotelName: "潮州古城酒店", diamond: 5, score: 4.7, distanceKm: 2, cityName: "潮州", anchorName: "广济桥", anchorCityId: 445 },
      { hotelId: 103, hotelName: "潮州府城酒店", diamond: 5, score: 4.6, distanceKm: 3, cityName: "潮州", anchorName: "广济桥", anchorCityId: 445 },
    ] },
    { day: 2, title: "南澳海岸", description: "游览南澳大桥", hotel: "无", meals: "自理", spots: [{ name: "南澳大桥", poiName: "南澳大桥", poiId: 102 }] },
  ];

  assert.equal(evaluatePreparationCompletion(value).currentNode, "hotelResolution");
  assert.equal(decidePreparationAction(value)?.name, "resolve_itinerary_hotels");
});

test("有效酒店评分和距离的小幅变化不刷新自动预算", () => {
  const value = product();
  value.product.operations!.hotelTier = "当地5钻酒店/-38";
  value.product.itinerary = [
    { day: 1, title: "潮州古城", description: "游览广济桥", hotel: "潮州5钻酒店", meals: "自理", spots: [{ name: "广济桥", poiName: null, poiId: null }], hotelCandidates: [
      { hotelId: 101, hotelName: "潮州金钻酒店", diamond: 5, score: 4.8, distanceKm: 1.2, cityName: "潮州", anchorName: "广济桥", anchorCityId: 445 },
    ] },
    { day: 2, title: "南澳海岸", description: "游览南澳大桥", hotel: "无", meals: "自理", spots: [{ name: "南澳大桥", poiName: null, poiId: null }] },
  ];
  const first = decidePreparationAction(value)!.progressKey;
  const candidate = value.product.itinerary![0]!.hotelCandidates![0]!;
  candidate.score = 4.9; candidate.distanceKm = 1.1;
  assert.equal(decidePreparationAction(value)!.progressKey, first);
});
