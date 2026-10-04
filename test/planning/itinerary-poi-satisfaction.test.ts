import assert from "node:assert/strict";
import test from "node:test";
import { itineraryPoiSatisfaction } from "../../src/shared/itinerary-poi-satisfaction.js";
import { effectiveItinerarySpotKind } from "../../src/shared/itinerary-activity-kind.js";

test("同一 or 组每个明确景点都必须有真实 POI", () => {
  const itinerary = [{ spots: [
    { name: "日喀则博物馆", kind: "attraction", relation: "or", poiName: "日喀则博物馆", poiId: 1 },
    { name: "非遗中心", kind: "attraction", relation: "or", poiName: null, poiId: null },
  ] }];
  assert.deepEqual(itineraryPoiSatisfaction(itinerary), { hasRequiredPoi: true, satisfied: false });
  (itinerary[0]!.spots[1] as Record<string, unknown>).poiName = "非遗中心";
  (itinerary[0]!.spots[1] as Record<string, unknown>).poiId = 2;
  assert.deepEqual(itineraryPoiSatisfaction(itinerary), { hasRequiredPoi: true, satisfied: true });
});

test("保留原景点备注不能把 attraction 伪装成 other，明确服务仍不是 POI", () => {
  assert.equal(effectiveItinerarySpotKind({ name: "非遗中心", kind: "attraction", poiName: null, poiId: null, remark: "已保留原景点和原行程位置，仅以文字录入" }), "attraction");
  assert.equal(effectiveItinerarySpotKind({ name: "送火车", kind: "other", poiName: null, poiId: null }), "other");
  assert.deepEqual(itineraryPoiSatisfaction([{ spots: [{ name: "送火车", kind: "other" }] }]), { hasRequiredPoi: false, satisfied: true });
});
