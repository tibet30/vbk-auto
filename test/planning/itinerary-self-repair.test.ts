import assert from "node:assert/strict";
import test from "node:test";
import { selfRepairItineraryForVbk } from "../../src/main/planning/itinerary-self-repair.js";
import {
  containsExcludedAlternativeMention,
  excludedItineraryAlternativeGroups,
  excludedItineraryAlternatives,
  repairExcludedAlternativeCopy,
} from "../../src/main/planning/itinerary-alternative-copy.js";
import { buildDayDescription } from "../../src/main/automation/ctrip/itinerary-api/itinerary-transform.js";
import { alternativeGroupKey } from "../../src/shared/trusted-operator-itinerary-removals.js";

test("末日明确不住宿才清理误填酒店，保留真实住宿与普通待核验 POI", () => {
  const original = [
    { day: 1, hotel: "酒店", spots: [{ name: "景点" }] },
    { day: 2, hotel: "酒店", spots: [{ name: "景点" }] },
    { day: 3, hotel: "酒店", hotelDescription: "送火车日不实际安排住宿", hotelCandidates: [{ hotelId: 1 }], spots: [{ name: "景点" }] },
  ];
  const result = selfRepairItineraryForVbk(original, 2);
  assert.equal(result.itinerary[0].hotel, "酒店");
  assert.equal(result.itinerary[2].hotel, "无");
  assert.equal(result.itinerary[2].hotelCandidates, undefined);
  assert.equal(original[2].hotel, "酒店");
  assert.equal(selfRepairItineraryForVbk(original, 3).itinerary[2].hotel, "酒店");
  original[2].hotelDescription = "入住酒店";
  assert.equal(selfRepairItineraryForVbk(original, 2).itinerary[2].hotel, "酒店");
});

test("纯交通和入住节点移出 POI 列表，明确二选一景点保持原序和关系", () => {
  const result = selfRepairItineraryForVbk([
    {
      day: 1,
      title: "接站游览后入住",
      description: "日喀则站接站，游览后入住酒店。",
      meals: "自理",
      spots: [
        { name: "日喀则火车站", relation: "and" },
        { name: "帕拉庄园", poiName: "帕拉庄园", poiId: 85093, relation: "and" },
        { name: "日喀则（入住）", relation: "and" },
      ],
    },
    {
      day: 2,
      title: "人文二选一",
      description: "非遗中心或博物馆二选一。",
      meals: "自理",
      spots: [
        { name: "日喀则非物质遗产中心", poiName: null, poiId: null, timeOfDay: "morning", relation: "or" },
        { name: "日喀则博物馆", poiName: "日喀则博物馆", poiId: 79437758, timeOfDay: "morning", relation: "or" },
        { name: "扎什伦布寺", poiName: "扎什伦布寺", poiId: 76348, timeOfDay: "afternoon", relation: "and" },
        { name: "日喀则火车站", relation: "and" },
      ],
    },
  ]);

  assert.equal(result.changed, true);
  assert.deepEqual(result.removedTravelNodes, ["日喀则火车站", "日喀则（入住）"]);
  assert.deepEqual(result.selectedAlternatives, []);
  assert.deepEqual(result.itinerary.map((day) => (day.spots as Array<{ name: string }>).map((spot) => spot.name)), [
    ["帕拉庄园"],
    ["日喀则非物质遗产中心", "日喀则博物馆", "扎什伦布寺", "日喀则火车站"],
  ]);
  assert.deepEqual((result.itinerary[1]!.spots as Array<Record<string, unknown>>).slice(0, 2).map((spot) => spot.relation), ["or", "or"]);
  assert.equal(result.itinerary[1]!.title, "人文二选一");
  assert.equal(result.itinerary[1]!.description, "非遗中心或博物馆二选一。");
});

test("普通未命中景点和全部未命中的二选一保持不动", () => {
  const itinerary = [{
    day: 1,
    title: "待核验",
    description: "待核验",
    meals: "自理",
    spots: [
      { name: "景点A", poiName: null, poiId: null, timeOfDay: "morning", relation: "or" },
      { name: "景点B", poiName: null, poiId: null, timeOfDay: "morning", relation: "or" },
      { name: "景点C", poiName: null, poiId: null, timeOfDay: "afternoon", relation: "and" },
    ],
  }];
  const result = selfRepairItineraryForVbk(itinerary);
  assert.equal(result.changed, false);
  assert.deepEqual(result.itinerary, itinerary);
  assert.deepEqual(result.selectedAlternatives, []);
});

test("明确 other/free 即使遗留 relation=or 也保留且不跨景点二选一分组", () => {
  const result = selfRepairItineraryForVbk([{ day: 1, spots: [
    { name: "景点甲", poiName: null, poiId: null, relation: "or", timeOfDay: "morning" },
    { name: "接机", kind: "other", relation: "or", timeOfDay: "morning" },
    { name: "景点乙", poiName: "景点乙", poiId: 2, relation: "or", timeOfDay: "morning" },
    { name: "自由活动", kind: "free", relation: "or", timeOfDay: "afternoon" },
  ] }]);
  const spots = result.itinerary[0].spots as Array<Record<string, unknown>>;
  assert.deepEqual(spots.map((spot) => spot.name), ["景点甲", "接机", "景点乙", "自由活动"]);
  assert.equal(spots[1].relation, "and");
  assert.equal(spots[3].relation, "and");
});

test("二选一未命中不改写当天外写文案，保留送火车和无住宿", () => {
  const result = selfRepairItineraryForVbk([
    { day: 1, title: "萨迦古城", description: "接火车后游览萨迦古城。晚住日喀则。", hotel: "日喀则酒店", spots: [{ name: "萨迦古城", poiName: "萨迦古城", poiId: 1 }] },
    { day: 2, title: "羊卓雍湖", description: "游览羊卓雍湖。晚住日喀则。", hotel: "日喀则酒店", spots: [{ name: "羊卓雍湖", poiName: "羊卓雍湖", poiId: 2 }] },
    { day: 3, title: "日喀则博物馆 · 非遗中心参观 · 扎什伦布寺", description: "按用户原定顺序安排：日喀则博物馆、非遗中心参观、扎什伦布寺。含送火车服务。当日返程，不安排住宿。", hotel: "无", hotelDescription: "当日返程，不安排住宿", spots: [
      { name: "日喀则博物馆", poiName: "日喀则博物馆", poiId: 3, relation: "or", timeOfDay: "morning" },
      { name: "非遗中心参观", poiName: null, poiId: null, relation: "or", timeOfDay: "morning" },
      { name: "扎什伦布寺", poiName: "扎什伦布寺", poiId: 4, relation: "and", timeOfDay: "afternoon" },
      { name: "送火车", kind: "other", relation: "and", timeOfDay: "afternoon", description: "送往日喀则火车站" },
    ] },
  ], 2);
  const day = result.itinerary[2]!;
  assert.deepEqual((day.spots as Array<{ name: string }>).map((spot) => spot.name), ["日喀则博物馆", "非遗中心参观", "扎什伦布寺", "送火车"]);
  assert.deepEqual((day.spots as Array<Record<string, unknown>>).slice(0, 2).map((spot) => spot.relation), ["or", "or"]);
  assert.equal(day.title.includes("非遗中心"), true);
  assert.equal(day.description.includes("非遗中心"), true);
  assert.equal(day.description, "按用户原定顺序安排：日喀则博物馆、非遗中心参观、扎什伦布寺。含送火车服务。当日返程，不安排住宿。");
  assert.equal(day.description.includes("送火车服务"), true);
  assert.equal(day.hotel, "无");
  assert.throws(() => buildDayDescription({ day: day as any, index: 2, totalDays: 3, operations: {}, stations: {} }), /缺 poiId\/poiName/);
});

test("只有可信人工删除凭证才能导出原始 OR 排除项", () => {
  const userIdea = "第一天：萨迦古城。\n第二天：羊卓雍湖。\n第三天：日喀则博物馆或非遗中心参观 → 扎什伦布寺参观 → 送火车。";
  const product = { product: { basicInfo: { userIdea } } } as any;
  const active = [
    { day: 1, spots: [{ name: "萨迦古城", poiName: "萨迦古城", poiId: 1 }] },
    { day: 2, spots: [{ name: "羊卓雍湖", poiName: "羊卓雍湖", poiId: 2 }] },
    { day: 3, spots: [{ name: "日喀则博物馆", poiName: "日喀则博物馆", poiId: 3 }, { name: "扎什伦布寺", poiName: "扎什伦布寺", poiId: 4 }] },
  ];
  assert.deepEqual(excludedItineraryAlternatives(product, active), new Map());
  product.product.manualReview = { itinerarySpotRemovals: [{ day: 3, name: "非遗中心参观", removedAt: "2026-10-04T00:00:00.000Z" }] };
  assert.deepEqual(excludedItineraryAlternatives(product, active), new Map([[3, ["非遗中心参观"]]]));
  const noMatch = structuredClone(active);
  (noMatch[2]!.spots[0] as { poiId: number | null }).poiId = null;
  assert.deepEqual(excludedItineraryAlternatives(product, noMatch), new Map([[3, ["非遗中心参观"]]]));
  assert.deepEqual(excludedItineraryAlternatives(product, [{ day: 3, spots: [{ name: "扎什伦布寺", poiName: "扎什伦布寺", poiId: 3 }] }]), new Map([[3, ["非遗中心参观"]]]));
});

test("未命中备选不会删服务、酒店城市或无关自定义文字", () => {
  const result = selfRepairItineraryForVbk([{ day: 1, title: "博物馆或非遗中心 · 自定义慢游", description: "博物馆或非遗中心参观。晚住非遗中心酒店，保留接站和自定义摄影时间。", hotel: "日喀则当地5钻酒店", hotelDescription: "晚住日喀则当地5钻酒店", spots: [
    { name: "博物馆", poiName: "博物馆", poiId: 1, relation: "or", timeOfDay: "morning" },
    { name: "非遗中心", poiName: null, poiId: null, relation: "or", timeOfDay: "morning" },
    { name: "接站", kind: "other", relation: "and", description: "日喀则火车站接站" },
  ] }]);
  const day = result.itinerary[0]!;
  assert.equal(day.title.includes("非遗中心"), true);
  assert.equal(day.description, "博物馆或非遗中心参观。晚住非遗中心酒店，保留接站和自定义摄影时间。");
  assert.equal(day.hotel, "日喀则当地5钻酒店");
  assert.equal(day.hotelDescription, "晚住日喀则当地5钻酒店");
  assert.equal((day.spots as Array<{ name: string }>).at(-1)?.name, "接站");
});

test("同义缩写仅在活动上下文命中，酒店名称不作为待清理景点", () => {
  const removed = ["日喀则非物质文化遗产中心参观"];
  assert.equal(containsExcludedAlternativeMention("安排非遗参观后送站。", removed), true);
  assert.equal(containsExcludedAlternativeMention("博物馆与非遗参观。", removed), true);
  assert.equal(containsExcludedAlternativeMention("非遗中心参观或博物馆二选一。", removed), true);
  assert.equal(containsExcludedAlternativeMention("晚住非遗中心酒店。", removed), false);
});

test("可信人工删除后才可按原始 OR 组幂等修正文案", () => {
  const product = { product: { basicInfo: { userIdea: "第一天：萨迦古城。\n第二天：羊卓雍湖。\n第三天：日喀则博物馆或非遗中心参观 → 扎什伦布寺。" }, manualReview: { itinerarySpotRemovals: [
    { day: 3, name: "非遗中心参观", removedAt: "2026-10-04T00:00:00.000Z" },
  ] } } } as any;
  const original = [{ day: 3, title: "人文二选一", description: "日喀则博物馆与非遗中心参观二选一。含送火车服务。", hotel: "无", hotelDescription: "当日返程，不安排住宿", spots: [
    { name: "日喀则博物馆", poiName: "日喀则博物馆", poiId: 1 },
    { name: "扎什伦布寺", poiName: "扎什伦布寺", poiId: 2 },
    { name: "送火车", kind: "other" },
  ] }];
  const repaired = repairExcludedAlternativeCopy(product, original);
  assert.equal(repaired.changed, true);
  assert.equal(repaired.itinerary[0]!.title, "日喀则博物馆 · 扎什伦布寺");
  assert.equal(repaired.itinerary[0]!.description, "日喀则博物馆。含送火车服务。");
  assert.equal(repaired.itinerary[0]!.hotelDescription, "当日返程，不安排住宿");
  assert.equal(repairExcludedAlternativeCopy(product, repaired.itinerary).changed, false);
});

test("无人工删除凭证时历史文案保持不变", () => {
  const product = { product: { basicInfo: { userIdea: "第一天：博物馆或非遗中心参观。" } } } as any;
  const original = [{ day: 1, title: "城市文化或许压轴", description: "博物馆或非遗中心参观。", spots: [
    { name: "博物馆", poiName: "博物馆", poiId: 1 },
  ] }];
  const repaired = repairExcludedAlternativeCopy(product, original);
  assert.equal(repaired.itinerary[0]!.title, "城市文化或许压轴");
  assert.equal(repaired.itinerary[0]!.description, "博物馆或非遗中心参观。");
});

test("同组 POI 未完整时保留所有已命名备选", () => {
  const result = selfRepairItineraryForVbk([{ day: 1, title: "景点A或景点B或景点C二选一", description: "景点A或景点B或景点C二选一。", spots: [
    { name: "景点A", poiName: "景点A", poiId: 1, relation: "or", timeOfDay: "morning" },
    { name: "景点B", poiName: "景点B", poiId: 2, relation: "or", timeOfDay: "morning" },
    { name: "景点C", poiName: null, poiId: null, relation: "or", timeOfDay: "morning" },
  ] }]);
  const day = result.itinerary[0]!;
  assert.equal(day.title, "景点A或景点B或景点C二选一");
  assert.equal(day.description, "景点A或景点B或景点C二选一。");
  assert.deepEqual((day.spots as Array<{ name: string; relation: string }>).map((spot) => [spot.name, spot.relation]), [["景点A", "or"], ["景点B", "or"], ["景点C", "or"]]);
});

test("同日不同 OR 组同名时，删除凭证只作用于带 groupKey 的原组", () => {
  const firstGroup = ["甲景点", "共同点"];
  const secondGroup = ["共同点", "乙景点"];
  const product = { planning: { userIntent: { activities: [
    { id: "first", day: 1, title: "甲景点", kind: "poi", alternatives: ["共同点"] },
    { id: "second", day: 1, title: "共同点", kind: "poi", alternatives: ["乙景点"] },
  ] } }, product: { basicInfo: {}, manualReview: { itinerarySpotRemovals: [
    { day: 1, name: "共同点", removedAt: "2026-10-04T00:00:00.000Z" },
  ] } } } as any;
  const itinerary = [{ day: 1, title: "共同点二选一", description: "甲景点或共同点二选一。共同点或乙景点二选一。", spots: [
    { name: "甲景点", poiName: "甲景点", poiId: 1, relation: "or" },
    { name: "共同点", poiName: "共同点", poiId: 2, relation: "or" },
    { name: "乙景点", poiName: "乙景点", poiId: 3, relation: "or" },
  ] }];
  assert.deepEqual(excludedItineraryAlternativeGroups(product, itinerary), []);
  product.product.manualReview.itinerarySpotRemovals[0].groupKey = alternativeGroupKey(1, firstGroup);
  assert.deepEqual(excludedItineraryAlternativeGroups(product, itinerary).map((item) => [item.group.names, item.names]), [[firstGroup, ["共同点"]]]);
  const repaired = repairExcludedAlternativeCopy(product, itinerary);
  assert.equal(repaired.changed, false, "同名景点仍在第二组活动行程中，文案不可归因清理");
  assert.deepEqual(repaired.itinerary, itinerary);
  assert.deepEqual(excludedItineraryAlternatives(product, itinerary), new Map([[1, ["共同点"]]]));
});
