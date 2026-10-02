import assert from "node:assert/strict";
import test from "node:test";
import { itinerarySpotKind } from "../../src/shared/itinerary-activity-kind.js";

test("历史行程类型兼容不把命名地点降级", () => {
  assert.equal(itinerarySpotKind({ name: "自由活动" }), "free");
  assert.equal(itinerarySpotKind({ name: "下午自由活动" }), "free");
  assert.equal(itinerarySpotKind({ name: "潮汕接团", description: "下午自由活动" }), "other");
  assert.equal(itinerarySpotKind({ name: "回坊小吃一条街自由活动" }), "attraction");
  assert.equal(itinerarySpotKind({ name: "任意地点", poiName: "已核验 POI", poiId: 1 }), "attraction");
});
