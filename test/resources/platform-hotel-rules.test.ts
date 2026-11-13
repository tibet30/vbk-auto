import assert from "node:assert/strict";
import test from "node:test";
import { normalisePlatformHotelProduct, platformHotelStayGroups, PLATFORM_HOTEL_DESCRIPTION as description, defaultPlatformHotelRules } from "../../src/shared/platform-hotel-rules.js";
import { resourceGaps } from "../../src/main/planning/preparation-checks/resources.js";
import { buildPlatformHotelRule, platformHotelRuleMatches } from "../../src/main/automation/ctrip/hotel-rule-protocol.js";
import { formalResourcesMatchDraft } from "../../src/main/automation/ctrip/resource-segment-finalization.js";
import { originalOvernightRoute } from "../../src/shared/original-itinerary-route.js";
import { verifiedRouteOvernightCity } from "../../src/shared/route-location-evidence.js";

const legacy = () => ({ basicInfo: { meetingCity: "成都", nights: 3 }, sales: { productForm: "freeTravel" },
  operations: { hotelResource: { source: "ctrip" }, hotelFallbackPolicy: { allowDowngrade: true } },
  itinerary: [
    { day: 1, hotel: "成都老酒店", hotelCity: "成都市", description: "入住成都老酒店，酒店距景区5公里", hotelRequirement: { cityName: "成都", diamond: 4 } },
    { day: 2, hotel: "四钻酒店", hotelCity: "成都", description: "当天游览人民公园" },
    { day: 3, hotel: "青城民宿", hotelCity: "都江堰市", description: "入住青城民宿" },
    { day: 4, hotel: "当日返程，不安排住宿", activities: [{ type: "hotel", title: "入住酒店" }] },
  ] });

test("旧酒店转换保留连续同城、多城与无住宿日，并可重复转换", () => {
  const input = legacy(); const result = normalisePlatformHotelProduct(input);
  assert.equal(input.itinerary[0]!.hotel, "成都老酒店");
  assert.deepEqual(result.operations.hotelRules, defaultPlatformHotelRules());
  assert.equal(result.operations.hotelResource, undefined);
  assert.equal(result.operations.hotelFallbackPolicy, undefined);
  assert.deepEqual(platformHotelStayGroups(result).map(({ cityName, nights }) => ({ cityName, nights })),
    [{ cityName: "成都", nights: 2 }, { cityName: "都江堰", nights: 1 }]);
  for (const day of result.itinerary.slice(0, 3)) {
    assert.equal(day.hotel, description); assert.equal(day.hotelRequirement, undefined); assert.equal(day.hotelCandidates, undefined);
    assert.doesNotMatch(day.description, /成都老酒店|青城民宿|5公里|四钻酒店/);
  }
  assert.equal(result.itinerary[3].hotelCity, undefined);
  assert.deepEqual(result.itinerary[3].activities, []);
  assert.deepEqual(normalisePlatformHotelProduct(result), result);
  assert.equal(resourceGaps(result).some(gap => gap.code === "hotel"), false);
});

test("规则缺失、自动匹配关闭、等级错误与缺少住宿城市均阻塞，转换不能掩盖无效规则", () => {
  for (const rules of [undefined, { autoMatch: false, grades: [3, 4, 5] }, { autoMatch: true, grades: [4] }]) {
    const product = normalisePlatformHotelProduct(legacy()); product.operations.hotelRules = rules;
    assert.equal(resourceGaps(product).some(gap => gap.code === "hotel"), true);
    assert.deepEqual(normalisePlatformHotelProduct(product).operations.hotelRules, rules);
  }
  const product = normalisePlatformHotelProduct(legacy()); delete product.itinerary[0].hotelCity;
  assert.equal(resourceGaps(product).some(gap => gap.code === "hotel"), true);
  product.itinerary[0].hotel = "";
  assert.equal(resourceGaps(product).some(gap => gap.code === "hotel"), true);
});

test("明确修正的住宿城市优先于旧酒店要求，重复保存不会恢复旧城市", () => {
  const input = legacy();
  input.itinerary[0]!.hotelCity = "都江堰市";
  const result = normalisePlatformHotelProduct(input);
  assert.equal(result.itinerary[0].hotelCity, "都江堰");
  assert.equal(normalisePlatformHotelProduct(result).itinerary[0].hotelCity, "都江堰");
});

test("跨城原始宿点修复误继承的接团城市，且保持平台自动匹配规则", () => {
  const input = { basicInfo: { meetingCity: "拉萨", nights: 2,
    userIdea: "阿里南线 D1天：拉萨—日喀则（宿日喀则） D2天：日喀则—珠峰（宿珠峰小镇） D3天：珠峰—拉萨" },
    operations: {}, itinerary: [
      { day: 1, hotel: description, hotelCity: "拉萨", spots: [] },
      { day: 2, hotel: description, hotelCity: "拉萨", spots: [] },
      { day: 3, hotel: "无", spots: [] },
    ] };
  const result = normalisePlatformHotelProduct(input);
  assert.deepEqual(result.itinerary.map((day: any) => day.hotelCity), ["日喀则", "定日", undefined]);
  assert.deepEqual(result.operations.hotelRules, { autoMatch: true, grades: [3, 4, 5] });
  assert.deepEqual(normalisePlatformHotelProduct(result), result);
});

test("平台规则草稿及正式回读拒绝指定酒店、错误等级和额外筛选条件", () => {
  const segment: any = { segmentId: "1", segmentBase: { destinationCity: { cityId: 28, cityName: "成都" } } };
  const rules = defaultPlatformHotelRules(); segment.hotel = buildPlatformHotelRule(segment, rules);
  assert.equal(segment.hotel.isIncludeSystem, undefined);
  assert.equal(segment.hotel.systemHotel.goodHotel, "F");
  assert.deepEqual(segment.hotel.systemHotel.geoLocation, { globalId: "28", name: "成都", categoryId: 3 });
  assert.equal(platformHotelRuleMatches(segment, rules), true);
  for (const empty of [undefined, null, []]) {
    const persisted = structuredClone(segment); persisted.hotel.segmentRooms = empty;
    assert.equal(platformHotelRuleMatches(persisted, rules), true, "平台未指定酒店可序列化为空列表或空值");
  }
  const persisted = structuredClone(segment);
  persisted.hotel.segmentRooms = null;
  persisted.hotel.systemHotel.zones = [{ key: "0", value: "不限" }];
  persisted.hotel.systemHotel.locations = [{ key: "0", value: "不限" }];
  assert.equal(platformHotelRuleMatches(persisted, rules), true);
  assert.equal(formalResourcesMatchDraft([segment], [persisted]), true);
  for (const change of [(s: any) => s.hotel.segmentRooms.push({ hotelId: 1 }),
    (s: any) => s.hotel.systemHotel.hotelStar.pop(), (s: any) => delete s.hotel.systemHotel,
    ...[true, false, "T"].map(value => (s: any) => s.hotel.systemHotel.goodHotel = value),
    (s: any) => s.hotel.systemHotel.geoLocation.globalId = 94,
    ...[0, -1, 1.5, "", "invalid"].map(value => (s: any) => {
      s.segmentBase.destinationCity.cityId = value;
      s.hotel.systemHotel.geoLocation.globalId = value;
    }),
    ...["", { length: 0 }, [{ hotelId: 1 }]].map(value => (s: any) => s.hotel.segmentRoomBlackList = value),
    ...["zones", "locations"].flatMap(key => [
      (s: any) => s.hotel.systemHotel[key] = [{ key: "1", value: "广安区" }],
      (s: any) => s.hotel.systemHotel[key] = [{ key: "0", value: "不限" }, { key: "1", value: "广安区" }],
      (s: any) => s.hotel.systemHotel[key] = [{ key: "0", value: "广安区" }],
    ]), (s: any) => s.hotel.systemHotel.ranking = [{ key: "0", value: "不限" }]]) {
    const bad = structuredClone(segment); change(bad);
    assert.equal(platformHotelRuleMatches(bad, rules), false);
    assert.equal(formalResourcesMatchDraft([segment], [bad]), false);
  }
});

test("用户原始路线中的酒店名称不再进入生成标题与接送说明", () => {
  const product = normalisePlatformHotelProduct({ basicInfo: { meetingCity: "广安", nights: 1,
    userIdea: "动车站-白塔公园-丽枫酒店\n丽枫酒店-邓小平故里" },
    itinerary: [{ day: 1, hotel: "广安富盈酒店", title: "动车站—白塔公园—入住丽枫酒店",
      activities: [{ type: "transport", title: "送至丽枫酒店", detail: "游览结束后送至丽枫酒店办理入住" }] }] });
  assert.doesNotMatch(JSON.stringify(product.itinerary), /丽枫|富盈/);
  assert.match(product.itinerary[0].title, /白塔公园/);
  assert.doesNotMatch(JSON.stringify(product.itinerary[0].activities), /三钻|四钻|五钻/);
  assert.equal(product.basicInfo.userIdea, "动车站-白塔公园-丽枫酒店\n丽枫酒店-邓小平故里");
});

test("旅游区住宿城市改写为行政城市", () => {
  const product = normalisePlatformHotelProduct({ basicInfo: { meetingCity: "深圳", nights: 2 }, operations: {},
    itinerary: [
      { day: 1, hotel: description, hotelCity: "潮汕", spots: [] },
      { day: 2, hotel: description, hotelCity: "潮汕", spots: [] },
      { day: 3, hotel: "无", spots: [] },
    ] });
  assert.deepEqual(product.itinerary.map((day: any) => day.hotelCity), ["汕头", "汕头", undefined]);
  assert.deepEqual(platformHotelStayGroups(product).map(({ cityName, nights }) => ({ cityName, nights })),
    [{ cityName: "汕头", nights: 2 }]);
});

test("已核验原路线落点为旅游区别名时按行政城市比对，不报不一致", () => {
  const userIdea = "D1天：深圳—潮汕 D2天：潮汕—深圳";
  const input: any = { basicInfo: { meetingCity: "深圳", nights: 1, userIdea }, operations: {},
    itinerary: [{ day: 1, hotel: description, hotelCity: "潮汕", spots: [] }, { day: 2, hotel: "无", spots: [] }] };
  const sourceRoute = originalOvernightRoute(input, input.itinerary[0])!;
  input.diagnostics = { routeLocations: [{ day: 1, name: "潮汕", districtId: 1, position: sourceRoute.indexOf("潮汕"),
    sourceRoute, routeKey: "k", province: "广东", city: "潮汕" }] };
  assert.equal(verifiedRouteOvernightCity(input, input.itinerary[0]), "潮汕");
  const product = normalisePlatformHotelProduct(input);
  assert.equal(product.itinerary[0].hotelCity, "汕头");
  assert.deepEqual(platformHotelStayGroups(product).map(({ cityName, nights }) => ({ cityName, nights })),
    [{ cityName: "汕头", nights: 1 }]);
});

test("原文明确写出的住宿城市不会被路线 POI 证据或推断改掉", () => {
  const input: any = { basicInfo: { meetingCity: "西宁", destinationCity: "西宁", province: "青海", nights: 1,
    userIdea: "D1：西宁 — 祁连 — 肃南" }, sales: { productForm: "freeTravel" }, operations: {},
    itinerary: [{ day: 1, hotel: "平台酒店", hotelCity: "肃南", spots: [] }, { day: 2, hotel: "无" }], diagnostics: {} };
  const source = originalOvernightRoute(input, { day: 1 })!;
  input.diagnostics.routeLocations = [{ day: 1, name: "肃南", province: "甘肃", city: "张掖", district: "肃南",
    districtId: 21323, position: source.indexOf("肃南"), sourceRoute: source,
    routeKey: JSON.stringify([source, 1]) }];
  const result = normalisePlatformHotelProduct(input);
  assert.equal(result.itinerary[0]!.hotelCity, "肃南", "保存城市在原文有据时不能被推断结果改掉或清空");
});

test("逐晚钻级、民宿与距离口径只作历史字段，不进入平台自动匹配规则", () => {
  const input: any = { basicInfo: { meetingCity: "成都", destinationCity: "成都", province: "四川", nights: 2,
    userIdea: "D1：成都 — 都江堰（宿都江堰，要求四钻民宿，距离5公里内）\nD2：都江堰 — 青城山" },
    sales: { productForm: "freeTravel" }, operations: {},
    itinerary: [
      { day: 1, hotel: "四钻民宿", hotelCity: "都江堰", hotelRequirement: { cityName: "都江堰", diamond: 4, ratingType: "homestay", maxDistanceKm: 5 } },
      { day: 2, hotel: "当地5钻酒店", hotelCity: "成都" },
    ] };
  const result = normalisePlatformHotelProduct(input);
  assert.deepEqual(result.operations.hotelRules, defaultPlatformHotelRules());
  for (const day of result.itinerary) {
    assert.equal(day.hotelRequirement, undefined);
    assert.equal(day.hotelCandidates, undefined);
    assert.equal((day as any).maxDistanceKm, undefined);
  }
  assert.deepEqual(result.itinerary.map((day: any) => day.hotelCity), ["都江堰", "成都"]);
  assert.equal(normalisePlatformHotelProduct(result).itinerary[0].hotelCity, "都江堰", "重复转换不得回退到旧钻级或距离口径");
});

test("历史产品的返程日不会被迁移成住宿夜，晚数不超过 basicInfo.nights", () => {
  const input: any = { basicInfo: { meetingCity: "西安", destinationCity: "西安", province: "陕西", days: 6, nights: 5,
    userIdea: "1-西安接---住太白山唐镇\n2-太白县---五丈原---住太白县咀头镇\n3-太白县---留坝---住留侯\n4-留侯---华阳古镇---住华阳古镇\n5-华阳---汉中---住汉中\n6-汉中送飞机/送高铁" },
    sales: { productForm: "privateTour" }, operations: { hotelTier: "当地5钻酒店", hotelResource: { resourceId: 1 } },
    itinerary: [
      { day: 1, hotel: "太白山唐镇附近住宿（待核验）", hotelCity: "眉" },
      { day: 2, hotel: "太白县咀头镇附近住宿（待核验）", hotelCity: "太白" },
      { day: 3, hotel: "留侯附近住宿（待核验）", hotelCity: "留坝" },
      { day: 4, hotel: "华阳古镇附近住宿（待核验）", hotelCity: "洋" },
      { day: 5, hotel: "汉中附近住宿（待核验）", hotelCity: "汉中" },
      { day: 6, hotel: "本日不含返程后住宿", hotelCity: "汉中" },
    ] };
  const result = normalisePlatformHotelProduct(input);
  assert.equal(result.itinerary[5].hotel, "无当日住宿安排");
  assert.equal(result.itinerary[5].hotelCity, undefined);
  assert.deepEqual(platformHotelStayGroups(result).reduce((sum: number, group: any) => sum + group.nights, 0), 5);
});

test("已保存城市只是当天途经点、原文宿另一地时按已核验落点纠正", () => {
  const input: any = { basicInfo: { meetingCity: "张掖", destinationCity: "张掖", province: "甘肃", days: 2, nights: 1,
    userIdea: "D1：张掖 — 祁连 — 肃南" }, sales: { productForm: "freeTravel" }, operations: {},
    itinerary: [{ day: 1, hotel: "平台酒店", hotelCity: "祁连" }, { day: 2, hotel: "无" }], diagnostics: {} };
  const source = originalOvernightRoute(input, { day: 1 })!;
  input.diagnostics.routeLocations = [{ day: 1, name: "肃南", province: "甘肃", city: "张掖", district: "肃南",
    districtId: 21323, position: source.indexOf("肃南"), sourceRoute: source,
    routeKey: JSON.stringify([source, 1]) }];
  const result = normalisePlatformHotelProduct(input);
  assert.equal(result.itinerary[0].hotelCity, "肃南", "途经点祁连不能当成原文指定住宿地");
  assert.deepEqual(platformHotelStayGroups(result).map(({ cityName }) => cityName), ["肃南"]);
});
