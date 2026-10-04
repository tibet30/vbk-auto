import assert from "node:assert/strict";
import test from "node:test";
import { itineraryStructureError } from "../../src/main/planning/itinerary-structure.js";

function day(day: number, overrides: Record<string, unknown> = {}) {
  return { day, title: `第${day}天`, description: "已安排当日活动", hotel: "无", meals: "自理",
    spots: [{ name: "宽窄巷子", kind: "attraction", poiName: null, poiId: null }], ...overrides };
}

test("accepts an unresolved POI and persisted resolver metadata as a valid structure", () => {
  const product = { basicInfo: { days: 2 }, itinerary: [
    day(1, { hotelCandidates: [{ hotelId: 1, hotelName: "示例酒店" }], spots: [{ name: "宽窄巷子", kind: "attraction", poiName: null, poiId: null, source: "resolver", province: "四川", city: "成都", district: "青羊区" }] }),
    day(2, { spots: [{ name: "自由活动", kind: "free", poiName: null, poiId: null, source: "resolver" }] }),
  ] };
  assert.equal(itineraryStructureError(product), undefined);
});

test("allows an empty day only when a complete service activity is preserved", () => {
  const product = { basicInfo: { days: 2 }, itinerary: [
    day(1, { spots: [], activities: [{ type: "other", time: "上午", title: "接站", detail: "按约定接站" }] }), day(2),
  ] };
  assert.equal(itineraryStructureError(product), undefined);
});

test("rejects missing and duplicate day structure", () => {
  assert.match(itineraryStructureError({ basicInfo: { days: 2 }, itinerary: [day(1)] }) ?? "", /天数/);
  assert.match(itineraryStructureError({ basicInfo: { days: 2 }, itinerary: [day(1), day(1)] }) ?? "", /连续且唯一/);
});
