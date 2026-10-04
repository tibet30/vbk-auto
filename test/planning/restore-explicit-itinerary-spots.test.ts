import assert from "node:assert/strict";
import test from "node:test";
import {
  expandExplicitAlternativeGroupOrder,
  restoreExplicitAlternativeGroupSpots,
  restoreMissingExplicitAlternativeSpots,
} from "../../src/main/planning/restore-explicit-itinerary-spots.js";

test("恢复未获人工删除凭证的非遗槽位，保留日序、酒店和服务", () => {
  const product = { product: { basicInfo: {} } } as any;
  const original = [{ day: 3, title: "日喀则人文", description: "博物馆参观后扎什伦布寺参观，送火车。", hotel: "无", hotelDescription: "当日返程，不安排住宿", spots: [
    { name: "日喀则博物馆", kind: "attraction", poiName: "日喀则博物馆", poiId: 79437758, timeOfDay: "morning", relation: "and" },
    { name: "扎什伦布寺", kind: "attraction", poiName: "扎什伦布寺", poiId: 76348, timeOfDay: "afternoon", relation: "and" },
    { name: "送火车", kind: "other", description: "送往日喀则火车站" },
  ] }];
  const result = restoreMissingExplicitAlternativeSpots(product, original, {
    day: 3, name: "非遗中心参观", after: "日喀则博物馆", before: "扎什伦布寺",
  });
  const day = result.itinerary[0]!;
  assert.equal(result.changed, true);
  assert.deepEqual((day.spots as Array<Record<string, unknown>>).map((spot) => ({
    name: spot.name, relation: spot.relation, timeOfDay: spot.timeOfDay, poiId: spot.poiId,
  })), [
    { name: "日喀则博物馆", relation: "or", timeOfDay: "morning", poiId: 79437758 },
    { name: "非遗中心参观", relation: "or", timeOfDay: "morning", poiId: null },
    { name: "扎什伦布寺", relation: "and", timeOfDay: "afternoon", poiId: 76348 },
    { name: "送火车", relation: undefined, timeOfDay: undefined, poiId: undefined },
  ]);
  assert.equal(day.hotel, "无");
  assert.equal(day.description, original[0]!.description);
});

test("已有槽位或不相邻锚点时不改变行程", () => {
  const product = { product: { basicInfo: {} } } as any;
  const itinerary = [{ day: 3, spots: [
    { name: "日喀则博物馆", relation: "and" }, { name: "其他景点" }, { name: "扎什伦布寺", relation: "and" },
  ] }];
  const result = restoreMissingExplicitAlternativeSpots(product, itinerary, {
    day: 3, name: "非遗中心参观", after: "日喀则博物馆", before: "扎什伦布寺",
  });
  assert.equal(result.changed, false);
  assert.deepEqual(result.itinerary, itinerary);
});

test("可信人工删除凭证阻止恢复", () => {
  const product = { product: { basicInfo: {}, manualReview: { itinerarySpotRemovals: [
    { day: 3, name: "非遗中心参观", removedAt: "2026-10-04T00:00:00.000Z" },
  ] } } } as any;
  const itinerary = [{ day: 3, spots: [{ name: "日喀则博物馆" }, { name: "扎什伦布寺" }] }];
  const result = restoreMissingExplicitAlternativeSpots(product, itinerary, {
    day: 3, name: "非遗中心参观", after: "日喀则博物馆", before: "扎什伦布寺",
  });
  assert.equal(result.changed, false);
  assert.deepEqual(result.itinerary, itinerary);
});

test("唯一一侧锚点可恢复 OR 组首位或末位，缺少锚点不猜测", () => {
  const product = { product: { basicInfo: {} } } as any;
  const firstMissing = [{ day: 1, spots: [{ name: "博物馆", relation: "and", timeOfDay: "morning" }, { name: "寺院", relation: "and" }] }];
  const first = restoreMissingExplicitAlternativeSpots(product, firstMissing, {
    day: 1, name: "非遗中心", before: "博物馆",
  });
  assert.deepEqual((first.itinerary[0]!.spots as Array<Record<string, unknown>>).map((spot) => [spot.name, spot.relation, spot.timeOfDay]), [
    ["非遗中心", "or", "morning"], ["博物馆", "or", "morning"], ["寺院", "and", undefined],
  ]);

  const lastMissing = [{ day: 1, spots: [{ name: "博物馆", relation: "and", timeOfDay: "morning" }, { name: "寺院", relation: "and" }] }];
  const last = restoreMissingExplicitAlternativeSpots(product, lastMissing, {
    day: 1, name: "非遗中心", after: "博物馆",
  });
  assert.deepEqual((last.itinerary[0]!.spots as Array<Record<string, unknown>>).map((spot) => [spot.name, spot.relation, spot.timeOfDay]), [
    ["博物馆", "or", "morning"], ["非遗中心", "or", "morning"], ["寺院", "and", undefined],
  ]);

  const noAnchor = restoreMissingExplicitAlternativeSpots(product, lastMissing, { day: 1, name: "非遗中心" });
  assert.equal(noAnchor.changed, false);
  assert.deepEqual(noAnchor.itinerary, lastMissing);
});

test("结构化 userIntent 的单一原始槽位展开完整 OR 后恢复，不扩展普通缺失", () => {
  const product = { planning: { userIntent: { activities: [{
    id: "d3-humanities", day: 3, title: "日喀则博物馆", kind: "poi", alternatives: ["非遗中心参观"],
  }] } }, product: { basicInfo: {} } } as any;
  const order = ["日喀则博物馆", "扎什伦布寺参观", "送火车"];
  const group = { day: 3, names: ["日喀则博物馆", "非遗中心参观"] };
  assert.deepEqual(expandExplicitAlternativeGroupOrder(order, group), ["日喀则博物馆", "非遗中心参观", "扎什伦布寺参观", "送火车"]);
  assert.deepEqual(expandExplicitAlternativeGroupOrder(["普通景点", "扎什伦布寺参观"], group), ["普通景点", "扎什伦布寺参观"]);
  const result = restoreExplicitAlternativeGroupSpots(product, [{ day: 3, spots: [
    { name: "日喀则博物馆", kind: "attraction", poiName: "日喀则博物馆", poiId: 79437758, relation: "and", timeOfDay: "morning" },
    { name: "扎什伦布寺参观", kind: "attraction", poiName: "扎什伦布寺", poiId: 76348, relation: "and", timeOfDay: "afternoon" },
    { name: "送火车", kind: "other" },
  ] }], order, group);
  assert.equal(result.changed, true);
  assert.deepEqual((result.itinerary[0]!.spots as Array<Record<string, unknown>>).map((spot) => [spot.name, spot.relation, spot.poiId]), [
    ["日喀则博物馆", "or", 79437758], ["非遗中心参观", "or", null], ["扎什伦布寺参观", "and", 76348], ["送火车", undefined, undefined],
  ]);
});

test("日喀则实际快照恢复后只有 Day3 的 OR 槽位变化，重复恢复幂等", () => {
  const product = { product: { basicInfo: { meetingCity: "日喀则", destinationCity: "日喀则" } } } as any;
  const original = [
    { day: 1, title: "萨迦古城 · 萨迦寺 · 冲拉山", description: "接火车后依次游览萨迦古城、萨迦寺、冲拉山。晚住日喀则。", hotel: "日喀则当地5钻酒店", spots: [
      { name: "萨迦古城", kind: "attraction", poiName: "萨迦古城", poiId: 101, timeOfDay: "morning", relation: "and" },
      { name: "萨迦寺", kind: "attraction", poiName: "萨迦寺", poiId: 102, timeOfDay: "afternoon", relation: "and" },
      { name: "冲拉山", kind: "attraction", poiName: "冲拉山", poiId: 103, timeOfDay: "afternoon", relation: "and" },
    ] },
    { day: 2, title: "帕拉庄园 · 满拉水库 · 卡若拉冰川 · 羊卓雍湖", description: "依次游览帕拉庄园、满拉水库、卡若拉冰川、羊卓雍湖。晚住日喀则。", hotel: "日喀则当地5钻酒店", spots: [
      { name: "帕拉庄园", kind: "attraction", poiName: "帕拉庄园", poiId: 201, timeOfDay: "morning", relation: "and" },
      { name: "满拉水库", kind: "attraction", poiName: "满拉水库", poiId: 202, timeOfDay: "morning", relation: "and" },
      { name: "卡若拉冰川", kind: "attraction", poiName: "卡若拉冰川", poiId: 203, timeOfDay: "afternoon", relation: "and" },
      { name: "羊卓雍湖", kind: "attraction", poiName: "羊卓雍湖", poiId: 204, timeOfDay: "afternoon", relation: "and" },
    ] },
    { day: 3, title: "日喀则博物馆 · 非遗中心参观 · 扎什伦布寺", description: "按用户原定顺序安排：日喀则博物馆、非遗中心参观、扎什伦布寺。含送火车服务。当日返程，不安排住宿。", hotel: "无", hotelDescription: "当日返程，不安排住宿", spots: [
      { name: "日喀则博物馆", kind: "attraction", poiName: "日喀则博物馆", poiId: 79437758, timeOfDay: "morning", relation: "and" },
      { name: "扎什伦布寺", kind: "attraction", poiName: "扎什伦布寺", poiId: 76348, timeOfDay: "afternoon", relation: "and" },
    ] },
  ];
  const restored = restoreMissingExplicitAlternativeSpots(product, original, {
    day: 3, name: "非遗中心参观", after: "日喀则博物馆", before: "扎什伦布寺",
  });
  const expected = structuredClone(original);
  const day3 = expected[2]!;
  (day3.spots as Array<Record<string, unknown>>)[0]!.relation = "or";
  (day3.spots as Array<Record<string, unknown>>).splice(1, 0, {
    name: "非遗中心参观", kind: "attraction", poiName: null, poiId: null, timeOfDay: "morning", relation: "or",
  });
  assert.equal(restored.changed, true);
  assert.deepEqual(restored.itinerary, expected);
  assert.deepEqual(restored.itinerary.flatMap((day) => (day.spots as Array<Record<string, unknown>>)
    .filter((spot) => spot.kind === "attraction")
    .map((spot) => [spot.name, spot.poiId])), [
    ["萨迦古城", 101], ["萨迦寺", 102], ["冲拉山", 103], ["帕拉庄园", 201], ["满拉水库", 202],
    ["卡若拉冰川", 203], ["羊卓雍湖", 204], ["日喀则博物馆", 79437758], ["非遗中心参观", null], ["扎什伦布寺", 76348],
  ]);
  const repeated = restoreMissingExplicitAlternativeSpots(product, restored.itinerary, {
    day: 3, name: "非遗中心参观", after: "日喀则博物馆", before: "扎什伦布寺",
  });
  assert.equal(repeated.changed, false);
  assert.deepEqual(repeated.itinerary, expected);
});
