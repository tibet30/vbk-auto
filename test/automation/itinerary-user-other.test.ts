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

function otherOnlyDay(): ProductItineraryDay {
  return {
    day: 1,
    title: "藏文化体验",
    spots: [],
    description: "按用户要求安排体验",
    hotel: "",
    meals: "三餐自理",
    activities: [{
      time: "下午", title: "藏香制作", detail: "体验藏香制作流程",
      type: "other", durationMinutes: 120, source: "user",
    }],
  };
}

test("无 POI 日可由用户 other 活动通过规划与自动化准入", () => {
  const day = otherOnlyDay();
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

test("other 补充说明进入回读期望", () => {
  const expectations = buildReadbackExpectations({ itinerary: [otherOnlyDay()], operations, stations });
  assert.equal(expectations.days[0].other.description, "下午 藏香制作：体验藏香制作流程");
});

test("AI 来源或缺字段的 other 不能绕过每日 POI 安全门", () => {
  const day = otherOnlyDay();
  day.activities![0].source = "ai";
  assert.equal(itineraryPoisAreComplete([day]), false);
  assert.equal(hasValidItinerary({ itinerary: [day] }), false);
  assert.throws(
    () => transformItinerary({ itinerary: [day], operations, stations }),
    /缺少已验证景点或用户明确的其他活动/,
  );
});
