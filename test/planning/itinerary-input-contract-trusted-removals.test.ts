import assert from "node:assert/strict";
import test from "node:test";
import { buildProductSnapshot } from "../../src/main/infrastructure/database/parts/product-draft.js";
import { agentPatchOperations } from "../../src/main/agent/integration-patch.js";
import { itineraryInputContractError } from "../../src/main/planning/itinerary-input-contract.js";
import {
  alternativeGroupKey,
  clearReappearedTrustedOperatorItineraryRemovals,
  sameTrustedOperatorItineraryRemovals,
} from "../../src/shared/trusted-operator-itinerary-removals.js";
import type { ProductDetail } from "../../src/shared/contracts.js";

test("原始接送和自由活动允许 other/free，命名景点不能借生成 kind 绕过", () => {
  const product = draft("D1: 潮汕接团 > 自由活动 > 南澳大桥\nD2: 开元寺");
  const itinerary = [
    { day: 1, spots: [
      { name: "潮汕接团", kind: "other", poiName: null, poiId: null },
      { name: "自由活动", kind: "free", poiName: null, poiId: null },
      { name: "南澳大桥", kind: "attraction", poiName: null, poiId: null },
    ] },
    { day: 2, spots: [{ name: "开元寺", kind: "attraction", poiName: null, poiId: null }] },
  ];
  assert.equal(itineraryInputContractError(product, itinerary), undefined);
  (itinerary[0]!.spots[2] as Record<string, unknown>).kind = "other";
  assert.match(itineraryInputContractError(product, itinerary) ?? "", /景点类型.*南澳大桥/);
});

test("日喀则真实卡点：已核验 OR 同组仍保留未命中景点，只有可信人工删除可缺席", () => {
  const product = draft("第一天：接火车 → 萨迦古城 → 萨迦寺 → 冲拉山欣赏珠峰东坡 → 住日喀则。\n第二天：帕拉庄园 → 满拉水库 → 卡若拉冰川 → 羊卓雍湖 → 住日喀则。\n第三天：日喀则博物馆或非遗中心参观 → 扎什伦布寺参观 → 送火车。");
  Object.assign(product.product.basicInfo!, { days: 3, nights: 2, meetingCity: "日喀则", destinationCity: "日喀则" });
  product.product.itinerary = [
    { day: 1, spots: ["萨迦古城", "萨迦寺", "冲拉山欣赏珠峰东坡"].map((name) => ({ name })) },
    { day: 2, spots: ["帕拉庄园", "满拉水库", "卡若拉冰川", "羊卓雍湖"].map((name) => ({ name })) },
    { day: 3, hotel: "日喀则当地5钻酒店", hotelDescription: "送火车日不实际安排住宿", spots: [
      { name: "日喀则博物馆", poiName: "日喀则博物馆", poiId: 79437758, relation: "or", timeOfDay: "morning" },
      { name: "非遗中心参观", poiName: null, poiId: null, relation: "or", timeOfDay: "morning" },
      { name: "扎什伦布寺参观", poiName: "扎什伦布寺", poiId: 76348, relation: "and", timeOfDay: "afternoon" },
    ] },
  ] as never;
  assert.equal(itineraryInputContractError(product, product.product.itinerary), undefined);
  assert.doesNotThrow(() => agentPatchOperations(product, { itinerary: [{ day: 3, description: "参观后送站" }] }));
  const removedByAi = structuredClone(product.product.itinerary);
  (removedByAi[2].spots as Array<Record<string, unknown>>).splice(1, 1);
  assert.match(itineraryInputContractError(product, removedByAi) ?? "", /二选一景点必须全部保留.*非遗中心/);
  assert.throws(() => agentPatchOperations(product, { itinerary: [{ day: 3, spots: removedByAi[2].spots as never }] }), /二选一景点必须全部保留/);

  product.product.manualReview = { itinerarySpotRemovals: [{ day: 3, name: "非遗中心参观", removedAt: "2026-10-04T00:00:00.000Z" }] };
  (removedByAi[2].spots as Array<Record<string, unknown>>)[0]!.relation = "and";
  assert.equal(itineraryInputContractError(product, removedByAi), undefined);
});

test("同日同名 OR 槽位的删除凭证不能豁免另一组", () => {
  const product = draft("", {
    version: 2, runId: "r", status: "running", currentNode: "itineraryDraft", nodes: [], poiCandidates: [], createdAt: "t", updatedAt: "t",
    userIntent: { rawIdea: "", preferences: [], activities: [
      { id: "am", day: 1, title: "甲", kind: "poi", alternatives: ["X"] },
      { id: "pm", day: 1, title: "乙", kind: "poi", alternatives: ["X"] },
    ] },
  });
  product.product.manualReview = { itinerarySpotRemovals: [{
    day: 1, name: "X", removedAt: "2026-10-04T00:00:00.000Z", groupKey: alternativeGroupKey(1, ["甲", "X"]),
  }] };
  const missingSecond = [{ day: 1, spots: [
    { name: "甲", kind: "attraction", relation: "and", timeOfDay: "morning" },
    { name: "午餐", kind: "other", relation: "and" },
    { name: "乙", kind: "attraction", relation: "and", timeOfDay: "afternoon" },
  ] }, { day: 2, spots: [{ name: "武侯祠" }] }];
  assert.match(itineraryInputContractError(product, missingSecond) ?? "", /二选一景点必须全部保留.*X/);
  (product.product.manualReview as { itinerarySpotRemovals: unknown[] }).itinerarySpotRemovals.push({
    day: 1, name: "X", removedAt: "2026-10-04T00:00:00.000Z", groupKey: alternativeGroupKey(1, ["乙", "X"]),
  });
  assert.equal(itineraryInputContractError(product, missingSecond), undefined);
});

test("原始 JSON 加回精确 OR 槽位会清理旧收据，之后 AI 不能再次删除", () => {
  const product = draft("第一天：甲或乙。第二天：武侯祠。");
  Object.assign(product.product.basicInfo!, { days: 2 });
  product.product.manualReview = { itinerarySpotRemovals: [{
    day: 1, name: "乙", removedAt: "2026-10-04T00:00:00.000Z", groupKey: alternativeGroupKey(1, ["甲", "乙"]),
  }] };
  product.product.itinerary = [{ day: 1, spots: [
    { name: "甲", relation: "or", timeOfDay: "morning", kind: "attraction" },
    { name: "乙", relation: "and", timeOfDay: "morning", kind: "attraction" },
  ] }, { day: 2, spots: [{ name: "武侯祠" }] }] as never;
  const raw = structuredClone(product.product);
  assert.equal(sameTrustedOperatorItineraryRemovals(product.product, raw), true);
  assert.equal(clearReappearedTrustedOperatorItineraryRemovals(raw), true);
  assert.deepEqual((raw.manualReview as { itinerarySpotRemovals: unknown[] }).itinerarySpotRemovals, []);
  const removedAgain = structuredClone(raw.itinerary) as Array<Record<string, unknown>>;
  (removedAgain[0]!.spots as unknown[]).splice(1, 1);
  product.product = raw as never;
  assert.match(itineraryInputContractError(product, removedAgain) ?? "", /二选一景点必须全部保留.*乙/);
});

test("普通锁定景点不能用 free 或 other 保留同名占位", () => {
  const product = draft("这次必须去宽窄巷子");
  for (const kind of ["free", "other"] as const) {
    assert.match(itineraryInputContractError(product, [
      { day: 1, spots: [{ name: "宽窄巷子", kind }] },
      { day: 2, spots: [{ name: "武侯祠" }] },
    ]) ?? "", /必须保留为景点类型.*宽窄巷子/);
  }
  assert.equal(itineraryInputContractError(product, [
    { day: 1, spots: [{ name: "宽窄巷子", kind: "attraction", poiName: null, poiId: null }] },
    { day: 2, spots: [{ name: "武侯祠" }] },
  ]), undefined);
});

test("AI 或原始 JSON 不能伪造、扩大或借相近名称复用人工删除凭证", () => {
  const product = draft("D1 去宽窄巷子");
  product.product.manualReview = { itinerarySpotRemovals: [{ day: 1, name: "日喀则博物馆", removedAt: "2026-10-04T00:00:00.000Z" }] };
  assert.throws(() => agentPatchOperations(product, { manualReview: { itinerarySpotRemovals: [] } }), /不允许修改字段/);
  assert.equal(sameTrustedOperatorItineraryRemovals(product.product, {
    ...product.product, manualReview: { itinerarySpotRemovals: [{ day: 1, name: "日喀则博物馆新馆", removedAt: "2026-10-04T00:00:00.000Z" }] },
  }), false);
  assert.equal(sameTrustedOperatorItineraryRemovals(product.product, structuredClone(product.product)), true);
});

function draft(userIdea: string, intent?: ProductDetail["planning"]): ProductDetail {
  const product = buildProductSnapshot({ destination: "成都", days: 2, productForm: "privateTour" });
  Object.assign(product.product.basicInfo!, { userIdea, subtitle: "成都两日", province: "四川", operationNotes: "按约定行程安排" });
  product.product.itinerary = [
    { day: 1, title: "宽窄巷子", spots: [{ name: "宽窄巷子" }], description: "游览", hotel: "无", meals: "自理" },
    { day: 2, title: "武侯祠", spots: [{ name: "武侯祠" }], description: "游览", hotel: "无", meals: "自理" },
  ];
  if (intent) product.planning = intent;
  return product;
}
