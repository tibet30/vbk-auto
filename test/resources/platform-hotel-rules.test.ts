import assert from "node:assert/strict";
import test from "node:test";
import { normalisePlatformHotelProduct, platformHotelStayGroups, PLATFORM_HOTEL_DESCRIPTION as description, defaultPlatformHotelRules } from "../../src/shared/platform-hotel-rules.js";
import { resourceGaps } from "../../src/main/planning/preparation-checks/resources.js";
import { buildPlatformHotelRule, platformHotelRuleMatches } from "../../src/main/automation/ctrip/hotel-rule-protocol.js";
import { formalResourcesMatchDraft } from "../../src/main/automation/ctrip/resource-segment-finalization.js";

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
