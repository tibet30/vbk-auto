import assert from "node:assert/strict";
import test from "node:test";
import { hasValidItinerary } from "../../src/main/automation/automation-contract.helpers.js";
import {
  buildReadbackExpectations,
  transformItinerary,
  type ProductItineraryDay,
} from "../../src/main/automation/ctrip/itinerary-api/itinerary-transform.js";
import { itineraryPoisAreComplete } from "../../src/main/planning/runtime.js";

const stations = {
  pickupTrain: { type: "train" as const, id: "CN001LSA", code: "CN001LSA", name: "拉萨", raw: {} },
  dropoffTrain: { type: "train" as const, id: "CN001LSA", code: "CN001LSA", name: "拉萨", raw: {} },
};
const operations = { pickupCity: "拉萨", transport: "charter" as const, mealsIncluded: false };

function freeOnlyDay(): ProductItineraryDay {
  return {
    day: 1,
    title: "藏文化体验",
    spots: [],
    description: "按用户要求安排体验",
    hotel: "",
    meals: "三餐自理",
    activities: [{
      time: "下午", title: "藏香制作", detail: "体验藏香制作流程",
      type: "free", durationMinutes: 120, source: "user",
    }],
  };
}

test("无 POI 日可由明确 free 活动通过规划与自动化准入", () => {
  const day = freeOnlyDay();
  assert.equal(itineraryPoisAreComplete([day]), true);
  assert.equal(hasValidItinerary({ itinerary: [day] }), true);
  const result = transformItinerary({ itinerary: [day], operations, stations });
  assert.equal(result[0].tourDailyInfos.some((info) => info.activeType?.key === 3), false);
  const other = result[0].tourDailyInfos.find((info) => info.activeType?.key === 7);
  assert.ok(other);
  assert.equal(other.description, "下午 藏香制作：体验藏香制作流程");
  assert.deepEqual(other.takeoffTime, { key: null, name: "下午" });
  assert.equal(other.takeTime, 120);
});

test("free 补充说明进入回读期望", () => {
  const expectations = buildReadbackExpectations({ itinerary: [freeOnlyDay()], operations, stations });
  assert.equal(expectations.days[0].activities[0]?.description, "下午 藏香制作：体验藏香制作流程");
});

test("明确分类的 free 不依赖来源，但缺字段仍不能绕过每日 POI 安全门", () => {
  const day = freeOnlyDay();
  day.activities![0].source = "ai";
  assert.equal(itineraryPoisAreComplete([day]), true);
  assert.equal(hasValidItinerary({ itinerary: [day] }), true);
  assert.equal(transformItinerary({ itinerary: [day], operations, stations }).length, 1);
  day.activities![0].detail = "";
  assert.equal(hasValidItinerary({ itinerary: [day] }), false);
});

test("other 使用已核验的 key=9，绝不伪装成 free", () => {
  const day = freeOnlyDay();
  day.activities![0].type = "other";
  const infos = transformItinerary({ itinerary: [day], operations, stations })[0]!.tourDailyInfos;
  assert.ok(infos.some((info) => info.activeType?.key === 9 && info.activeType?.name === "其他"));
  assert.ok(!infos.some((info) => info.activeType?.key === 7 && info.activeType?.name === "其他"));
});

test("统一 spots 保留景点、其他、自由活动、景点的携程卡片顺序", () => {
  const day: ProductItineraryDay = {
    day: 1, title: "混合活动", description: "", hotel: "", meals: "自理",
    spots: [
      { name: "甲", poiName: "甲POI", poiId: 1, kind: "attraction", timeOfDay: "morning" },
      { name: "潮汕接团", kind: "other", description: "工作人员接团", timeOfDay: "morning" },
      { name: "自由活动", kind: "free", description: "自行安排", timeOfDay: "afternoon" },
      { name: "乙", poiName: "乙POI", poiId: 2, kind: "attraction", timeOfDay: "afternoon" },
    ],
  };
  const infos = transformItinerary({ itinerary: [day], operations, stations })[0]!.tourDailyInfos;
  const business = infos.filter((info) => [3, 7, 9].includes(Number(info.activeType?.key)));
  assert.deepEqual(business.map((info) => info.activeType?.key), [3, 9, 7, 3]);
  const expected = buildReadbackExpectations({ itinerary: [day], operations, stations }).days[0].timeline;
  assert.deepEqual(expected.map((entry) => entry.kind), ["attraction", "other", "free", "attraction"]);
});

test("未标时段的统一 spots 在转换与回读期望使用同一均分时段", () => {
  const day: ProductItineraryDay = { day: 1, title: "默认时段", description: "", hotel: "", meals: "自理", spots: [
    { name: "甲", kind: "attraction", poiName: "甲", poiId: 1 },
    { name: "接团", kind: "other", description: "服务" },
    { name: "乙", kind: "attraction", poiName: "乙", poiId: 2 },
  ] };
  const business = transformItinerary({ itinerary: [day], operations, stations })[0]!.tourDailyInfos.filter((info) => [3, 9].includes(Number(info.activeType?.key)));
  assert.deepEqual(business.map((info) => [info.activeType?.key, info.takeoffTime?.name]), [[3, "上午"], [9, "上午"], [3, "下午"]]);
  assert.deepEqual(buildReadbackExpectations({ itinerary: [day], operations, stations }).days[0].timeline.map((entry) => entry.kind), ["attraction", "other", "attraction"]);
});
