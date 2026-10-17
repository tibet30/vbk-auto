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
import { buildProductSnapshot } from "../../src/main/infrastructure/database/parts/product-draft.js";
import { itineraryInputContractError } from "../../src/main/planning/itinerary-input-contract.js";
import { isPersistedRouteTravelNode } from "../../src/shared/itinerary-route-travel-node.js";

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

test("原始路线证据在 POI 查询前移除接团城、宿点和道班，保留真实景点", () => {
  const itinerary = [
    { day: 1, title: "拉萨—羊卓雍措—日喀则", spots: [{ name: "拉萨" }, { name: "羊卓雍措" }] },
    { day: 5, title: "塔钦--札达--塔钦", spots: [
      { name: "塔钦", poiName: "塔钦", poiId: 145328355 },
      { name: "札达", poiName: null, poiId: null },
      { name: "扎达土林", poiName: "札达土林国家地质公园", poiId: 76422, province: "西藏", city: "阿里", district: "札达" },
    ] },
    { day: 6, title: "塔钦--仲巴--萨嘎", spots: [{ name: "塔钦" }, { name: "仲巴五彩沙漠" }] },
    { day: 7, title: "萨嘎--22道班--日喀则--拉萨", spots: [{ name: "22道班" }, { name: "浪措湖" }, { name: "拉萨" }] },
  ];
  const product = { basicInfo: { meetingCity: "拉萨", nights: 6,
    userIdea: "D1天：拉萨—羊卓雍措—日喀则（宿日喀则） D5天：塔钦--札达--塔钦（宿塔尔钦） D6天：塔钦--仲巴--萨嘎（宿萨嘎） D7天：萨嘎--22道班--日喀则--拉萨" }, itinerary };
  const result = selfRepairItineraryForVbk(itinerary, 6, product);
  assert.deepEqual(result.removedTravelNodes, ["拉萨", "塔钦", "札达", "塔钦", "22道班", "拉萨"]);
  assert.deepEqual(result.itinerary.map(day => (day.spots as any[]).map(spot => spot.name)),
    [["羊卓雍措"], ["扎达土林"], ["仲巴五彩沙漠"], ["浪措湖"]]);
});

test("POI 保存契约与自修复共用住宿路线节点判定，且不吞掉古镇景点", () => {
  const product = buildProductSnapshot({ destination: "拉萨", days: 2, productForm: "privateTour" });
  Object.assign(product.product.basicInfo!, {
    meetingCity: "拉萨",
    destinationCity: "拉萨",
    userIdea: "D1天：塔钦--札达土林--塔钦（宿塔尔钦）\nD2天：塔钦--仲巴五彩沙漠--萨嘎（宿萨嘎）",
  });
  product.product.itinerary = [
    { day: 1, title: "塔钦--札达土林--塔钦", spots: [{ name: "塔钦" }, { name: "札达土林" }], hotelCity: "普兰" },
    { day: 2, title: "塔钦--仲巴五彩沙漠--萨嘎", spots: [{ name: "塔钦" }, { name: "仲巴五彩沙漠" }], hotelCity: "萨嘎" },
  ];
  const repaired = selfRepairItineraryForVbk(product.product.itinerary, 2, product.product);
  assert.deepEqual(repaired.removedTravelNodes, ["塔钦", "塔钦"]);
  assert.equal(itineraryInputContractError(product, repaired.itinerary), undefined);
  assert.equal(isPersistedRouteTravelNode(product.product, { day: 1, title: "拉萨—华阳古镇—日喀则" }, "华阳古镇"), false);
});

test("珠峰小镇住宿允许次日巴松村作为路线起点，但不能全局豁免同名景点", () => {
  const product = buildProductSnapshot({ destination: "拉萨", days: 3, productForm: "privateTour",
    userIdea: [
      "D1天：拉萨—羊卓雍措—日喀则（宿日喀则）",
      "D2天：日喀则—珠峰（宿珠峰小镇）",
      "D3天：巴松村—佩枯措—萨嘎（宿萨嘎）",
    ].join(" ") });
  Object.assign(product.product.basicInfo!, { meetingCity: "拉萨", destinationCity: "拉萨" });
  const itinerary = [
    { day: 1, title: "拉萨—羊卓雍措—日喀则", spots: [
      { name: "拉萨", kind: "other" }, { name: "羊卓雍措", kind: "attraction" }, { name: "日喀则", kind: "other" },
    ] },
    { day: 2, title: "日喀则—珠峰", spots: [
      { name: "日喀则", kind: "other" }, { name: "珠峰", kind: "attraction" },
    ] },
    { day: 3, title: "巴松村—佩枯措—萨嘎", spots: [
      { name: "巴松村", kind: "other" }, { name: "佩枯措", kind: "attraction" }, { name: "萨嘎", kind: "other" },
    ] },
  ];
  assert.equal(isPersistedRouteTravelNode(product.product, itinerary[2]!, "巴松村"), true);
  assert.equal(itineraryInputContractError(product, itinerary), undefined);

  const standalone = buildProductSnapshot({ destination: "拉萨", days: 1, productForm: "privateTour", userIdea: "D1：巴松村" });
  Object.assign(standalone.product.basicInfo!, { meetingCity: "拉萨", destinationCity: "拉萨" });
  assert.equal(isPersistedRouteTravelNode(standalone.product, { day: 1, title: "巴松村" }, "巴松村"), false);
  assert.match(itineraryInputContractError(standalone, [
    { day: 1, title: "巴松村", spots: [{ name: "巴松村", kind: "other" }] },
  ]) ?? "", /必须保留为景点类型/);
});

test("人工审查改为其他活动并留下核查凭证后，契约保留名称但不再强迫伪造 POI", () => {
  const product = buildProductSnapshot({ destination: "拉萨", days: 1, productForm: "privateTour" });
  Object.assign(product.product.basicInfo!, { userIdea: "D1：巴松村", meetingCity: "拉萨", destinationCity: "拉萨" });
  product.product.itinerary = [{ day: 1, title: "巴松村", spots: [{ name: "巴松村", kind: "other", poiName: null, poiId: null }] }];
  const next = structuredClone(product.product.itinerary);
  assert.match(itineraryInputContractError(product, next) ?? "", /必须保留为景点类型/);
  product.researchTasks = [{ id: "manual-kind", label: "核查 巴松村 的 VBK POI 映射", type: "vbk",
    status: "succeeded", state: "confirmed", evidence: [{ id: "evidence", title: "[itinerary-kind:no-poi] 运营人工分类",
      source: "user", retrievedAt: "2026-10-16T00:00:00.000Z", accepted: true }] }];
  assert.equal(itineraryInputContractError(product, next), undefined);
  assert.equal(itineraryInputContractError(product, [{ day: 1, title: "巴松村", spots: [] }]), undefined,
    "可信人工非 POI 分类也应从完整路线的必保留景点集合中豁免");
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
