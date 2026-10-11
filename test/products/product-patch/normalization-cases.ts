import test from "node:test";
import assert from "node:assert/strict";
import { applyProductPatch } from "../../../src/main/operations/product-patch.js";
import { normalisePresentation, normaliseItinerary, normaliseProductDraft } from "../../../src/main/data/product-normalize.js";
import { defaultCommercialInventory } from "../../../src/main/data/commercial-defaults.js";
import { normaliseItinerarySupport } from "../../../src/shared/itinerary-support-arrangements.js";

test("应用新补丁时会同步修正已有的 MiniMax 展示和行程结构", () => {
  const product = {
    basicInfo: { supplierProductName: "太原2天1晚私家团" },
    presentation: { productName: "太原私家团", highlights: ["专车服务"], description: "两天探访太原。" },
    itinerary: [{ day: 1, title: "晋祠探古", summary: "游览晋祠", activities: [{ name: "晋祠博物馆", detail: "参观古建" }], meals: { breakfast: "自理", lunch: "自理", dinner: "自理" }, stay: "太原酒店" }],
  };

  const result = applyProductPatch(product, [{ op: "add", path: "/basicInfo/province", value: "山西" }]);

  assert.deepEqual(result.presentation, { recommendationCategory: "优选行程", recommendation: "两天探访太原。", features: "专车服务" });
  assert.equal((result.itinerary as Array<Record<string, unknown>>)[0].meals, "早餐自理；午餐自理；晚餐自理");
  assert.deepEqual((result.itinerary as Array<Record<string, unknown>>)[0].spots, ["晋祠博物馆"]);
});

test("草稿归一化会移除无效运营占位值", () => {
  const product = {
    operations: { transport: "", pickupCity: "", reusePickupForDropoff: null, hotelSource: "", hotelTier: "待核查", mealsIncluded: "待核查" },
    commercial: { packageName: "", terms: "待核查" },
    itinerary: [],
  };

  const result = applyProductPatch(product, [{ op: "add", path: "/basicInfo/province", value: "山西" }]);

  assert.deepEqual(result.operations, { vehicleResource: {}, hotelFallbackPolicy: { allowDowngrade: true } });
  assert.deepEqual(result.commercial, { inventory: defaultCommercialInventory() });
});

test("normaliseProductDraft 在 commercial 存在但缺少库存时补默认班期库存", () => {
  const result = normaliseProductDraft({
    commercial: {
      packageName: "标准套餐",
      pricing: { currency: "CNY", adult: 599, child: 399, minimumTravelers: 2 },
    },
  });

  assert.deepEqual((result.commercial as Record<string, unknown>).inventory, defaultCommercialInventory());
});

test("normaliseProductDraft 在 commercial.inventory 非法时补默认班期库存", () => {
  const result = normaliseProductDraft({
    commercial: {
      inventory: { startDate: "2026-10-01", endDate: "2026-09-01", dailyQuota: 0 },
    },
  });

  assert.deepEqual((result.commercial as Record<string, unknown>).inventory, defaultCommercialInventory());
});

test("normaliseProductDraft 保留已有合法 commercial.inventory", () => {
  const inventory = { startDate: "2026-09-01", endDate: "2026-09-30", dailyQuota: 12 };
  const result = normaliseProductDraft({
    commercial: {
      inventory,
    },
  });

  assert.deepEqual((result.commercial as Record<string, unknown>).inventory, inventory);
});

test("normaliseProductDraft 接纳旧 Agent 的酒店候选 item 包装", () => {
  const result = normaliseProductDraft({
    itinerary: [{
      day: 1, title: "日喀则", hotel: "维也纳酒店",
      hotelCandidates: { item: [{
        hotelId: "130061572", hotelName: "维也纳酒店", diamond: "4", score: "4.8", distanceKm: "1.59",
        cityName: "江孜", anchorName: "白居寺", anchorCityId: "20859",
      }] },
    }],
  });

  assert.deepEqual((result.itinerary as Array<Record<string, unknown>>)[0]?.hotelCandidates, [{
    hotelId: 130061572, hotelName: "维也纳酒店", diamond: 4, score: 4.8, distanceKm: 1.59,
    cityName: "江孜", anchorName: "白居寺", anchorCityId: 20859,
  }]);
});

test("草稿归一化保留空 vehicleResource 并为旧 operations 补空对象", () => {
  const result = normaliseProductDraft({
    operations: { hotelSource: "nonPlatform", hotelTier: "当地5钻酒店/-38", mealsIncluded: false },
  });

  assert.deepEqual((result.operations as Record<string, unknown>).vehicleResource, {});
});

test("默认酒店降档策略保留明确禁止，反复归一化不扩大许可", () => {
  for (const allowDowngrade of [true, false]) {
    const result = normaliseProductDraft({ operations: { hotelFallbackPolicy: { allowDowngrade } } });
    assert.deepEqual((result.operations as Record<string, unknown>).hotelFallbackPolicy, { allowDowngrade });
    assert.deepEqual(normaliseProductDraft(result), result);
  }
});

test("餐食迁移替换旧占位文案，已有正式餐食优先，空白日仍保留占位", () => {
  const activity = { time: "12:00", title: "午餐", detail: "自理", type: "meal" };
  for (const meals of [undefined, "", "餐食以实际确认单为准", "早餐含；午餐含"]) {
    const result = normaliseItinerary([{ day: 1, title: "第一天", meals, activities: [activity] }])!;
    assert.equal(result[0].meals, meals === "早餐含；午餐含" ? meals : "午餐自理");
    assert.deepEqual(result[0].activities, []);
    assert.deepEqual(normaliseItinerarySupport(result[0]), result[0]);
    assert.equal(normaliseItinerary(result)![0].meals, result[0].meals);
  }
  assert.equal(normaliseItinerary([{ day: 1, title: "第一天" }])![0].meals, "餐食以实际确认单为准");
});

test("normalisePresentation 仅在 recommendations 合法时保留", () => {
  const valid = normalisePresentation({
    recommendationCategory: "优选行程",
    recommendation: "两天探访太原。",
    features: "专车服务",
    recommendations: [
      { category: "优选行程", text: "深度探访晋祠" },
      { category: "精选酒店", text: "入住市中心" },
      { category: "缤纷景点", text: "三大必去" },
    ],
  });
  assert.deepEqual(valid?.recommendations, [
    { category: "优选行程", text: "深度探访晋祠" },
    { category: "精选酒店", text: "入住市中心" },
    { category: "缤纷景点", text: "三大必去" },
  ]);
});

test("normalisePresentation 将历史字符串 minQuality 归一为数字", () => {
  const result = normalisePresentation({
    recommendation: "推荐",
    features: "特色",
    cover: { source: "ctripLibrary", poi: "景点", description: "横版", minQuality: "3" },
  });
  assert.equal((result?.cover as { minQuality?: unknown })?.minQuality, 3);
});

test("normalisePresentation 会拒绝非法 recommendations：长度不对、空白 text、未知分类、重复分类", () => {
  const make = (recommendations: unknown) =>
    normalisePresentation({
      recommendationCategory: "优选行程",
      recommendation: "两天探访太原。",
      features: "专车服务",
      recommendations,
    });

  assert.equal(make([{ category: "优选行程", text: "a" }]).recommendations, undefined);
  assert.equal(
    make([
      { category: "优选行程", text: "a" },
      { category: "精选酒店", text: "b" },
      { category: "缤纷景点", text: "c" },
      { category: "特色美食", text: "d" },
    ]).recommendations,
    undefined,
  );
  assert.equal(
    make([
      { category: "优选行程", text: "  " },
      { category: "精选酒店", text: "b" },
      { category: "缤纷景点", text: "c" },
    ]).recommendations,
    undefined,
  );
  assert.equal(
    make([
      { category: "未知分类", text: "a" },
      { category: "精选酒店", text: "b" },
      { category: "缤纷景点", text: "c" },
    ]).recommendations,
    undefined,
  );
  assert.equal(
    make([
      { category: "优选行程", text: "a" },
      { category: "优选行程", text: "b" },
      { category: "缤纷景点", text: "c" },
    ]).recommendations,
    undefined,
  );
  // 非数组直接拒绝
  assert.equal(
    normalisePresentation({
      recommendationCategory: "优选行程",
      recommendation: "两天探访太原。",
      features: "专车服务",
      recommendations: "优选行程：a",
    })?.recommendations,
    undefined,
  );
});

test("normaliseItinerary 保留游览活动并把午餐内容迁入餐食字段", () => {
  const result = normaliseItinerary([
    {
      day: 1,
      title: "第一天",
      activities: [
        { time: "09:00", name: "晋祠博物馆", detail: "参观古建", type: "visit" },
        { time: "12:00", title: "午餐", detail: "自理", type: "meal" },
      ],
    },
  ]);
  assert.deepEqual((result as Array<Record<string, unknown>>)[0].activities, [
    { time: "09:00", title: "晋祠博物馆", detail: "参观古建", type: "visit" },
  ]);
  assert.equal((result as Array<Record<string, unknown>>)[0].meals, "午餐自理");
  assert.deepEqual(normaliseItinerarySupport(result![0]), result![0]);
});

test("normaliseItinerary 保留景点的上午/下午分段，供 VBK 节点按餐食拆分", () => {
  const result = normaliseItinerary([{
    day: 1,
    title: "分段行程",
    description: "上午游览甲；午餐自理；下午游览乙",
    meals: "午餐自理；晚餐自理",
    spots: [
      { name: "甲", poiName: "甲", poiId: 1, timeOfDay: "morning" },
      { name: "乙", poiName: "乙", poiId: 2, timeOfDay: "afternoon", relation: "or" },
    ],
  }]) as Array<{ spots: Array<{ timeOfDay?: string; relation?: string }> }>;
  assert.deepEqual(result[0].spots.map((spot) => spot.timeOfDay), ["morning", "afternoon"]);
  assert.deepEqual(result[0].spots.map((spot) => spot.relation), [undefined, "or"]);
});

test("normaliseItinerary 对非法 activities 拒绝保留：缺字段、空字段、未知 type 降级", () => {
  const result = normaliseItinerary([
    {
      day: 1,
      title: "第一天",
      activities: [
        { time: "09:00", title: "晋祠博物馆", detail: "参观古建", type: "sightseeing" }, // 未知 -> other
        { time: "", title: "无时间", detail: "x", type: "visit" }, // 空 time -> 丢弃
        { time: "10:00", title: "   ", detail: "x", type: "visit" }, // 空 title -> 丢弃
        { time: "11:00", title: "无详情", detail: "", type: "visit" }, // 空 detail -> 丢弃
        { time: "12:00", title: "午餐", detail: "自理", type: "meal" }, // 合法
      ],
    },
  ]) as Array<Record<string, unknown>>;
  const activities = result[0].activities as Array<Record<string, unknown>>;
  assert.equal(activities.length, 1);
  assert.deepEqual(activities[0], { time: "09:00", title: "晋祠博物馆", detail: "参观古建", type: "other" });
  assert.equal(result[0].meals, "午餐自理");
  assert.deepEqual(normaliseItinerarySupport(result[0]), result[0]);
});

test("normaliseItinerary 保留自由活动，接团迁入服务活动且不携带错误 POI", () => {
  const result = normaliseItinerary([{ day: 1, title: "类型", spots: [
    { name: "自由活动", kind: "free", description: "自行安排", poiName: "错误POI", poiId: 9 },
    { name: "潮汕接团", kind: "other", description: "接团服务", poiName: "错误POI", poiId: 8 },
  ] }]) as Array<{ spots: Array<Record<string, unknown>>; activities: Array<Record<string, unknown>> }>;
  assert.deepEqual(result[0].spots.map((spot) => ({ kind: spot.kind, description: spot.description, poiId: spot.poiId, poiName: spot.poiName })), [
    { kind: "free", description: "自行安排", poiId: null, poiName: null },
  ]);
  assert.deepEqual(result[0].activities, [{ time: "不限", title: "潮汕接团",
    detail: "类型；潮汕接团；接团服务", type: "transport" }]);
  assert.deepEqual(normaliseItinerary(result), result);
});
