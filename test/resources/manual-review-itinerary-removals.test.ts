import assert from "node:assert/strict";
import test from "node:test";
import { applyManualReviewField } from "../../src/main/operations/manual-review-field.js";
import { alternativeGroupKey } from "../../src/shared/trusted-operator-itinerary-removals.js";

test("行程站点手动删除留下精确删除凭证", () => {
  const product = { itinerary: [
    { day: 1, spots: [{ name: "晋祠", poiName: null, poiId: null }, { name: "已有景点", poiName: "已有 POI", poiId: 100 }], activities: [
      { time: "09:00", title: "晋祠", type: "visit", detail: "游览晋祠" },
    ] },
    { day: 2, spots: [] },
  ] };
  const next = applyManualReviewField(product, { field: "itinerarySpotRemove", dayIndex: 0, spotIndex: 0 });
  const receipts = (next.manualReview as Record<string, unknown>).itinerarySpotRemovals as Array<Record<string, unknown>>;
  assert.deepEqual({ day: receipts[0]!.day, name: receipts[0]!.name }, { day: 1, name: "晋祠" });
  assert.match(String(receipts[0]!.removedAt), /^\d{4}-\d{2}-\d{2}T/);
});

test("手动删除只收敛所在连续 OR 组，并留下精确删除凭证", () => {
  const product = { itinerary: [{ day: 1, title: "D1", description: "行程", hotel: "无", meals: "自理", spots: [
    { name: "甲", relation: "or", timeOfDay: "morning", poiName: null, poiId: null },
    { name: "乙", relation: "or", timeOfDay: "morning", poiName: null, poiId: null },
    { name: "午餐", kind: "other", relation: "and", timeOfDay: "morning", poiName: null, poiId: null },
    { name: "丙", relation: "or", timeOfDay: "afternoon", poiName: null, poiId: null },
    { name: "丁", relation: "or", timeOfDay: "afternoon", poiName: null, poiId: null },
  ] }] };
  const next = applyManualReviewField(product, { field: "itinerarySpotRemove", dayIndex: 0, spotIndex: 1 });
  const spots = ((next.itinerary as Array<Record<string, unknown>>)[0]!.spots as Array<Record<string, unknown>>);
  assert.deepEqual(spots.map((spot) => [spot.name, spot.relation]), [["甲", "and"], ["午餐", "and"], ["丙", "or"], ["丁", "or"]]);
  const receipts = (next.manualReview as Record<string, unknown>).itinerarySpotRemovals as Array<Record<string, unknown>>;
  assert.equal(receipts[0]!.day, 1);
  assert.equal(receipts[0]!.name, "乙");
  assert.match(String(receipts[0]!.removedAt), /^\d{4}-\d{2}-\d{2}T/);
});

test("同日两个 OR 组含同名点时，删除凭证只绑定被删的组", () => {
  const product = { itinerary: [{ day: 1, spots: [
    { name: "甲", relation: "or", timeOfDay: "morning", poiName: null, poiId: null },
    { name: "X", relation: "or", timeOfDay: "morning", poiName: null, poiId: null },
    { name: "午餐", kind: "other", relation: "and", timeOfDay: "morning" },
    { name: "乙", relation: "or", timeOfDay: "afternoon", poiName: null, poiId: null },
    { name: "X", relation: "or", timeOfDay: "afternoon", poiName: null, poiId: null },
  ] }] };
  const next = applyManualReviewField(product, { field: "itinerarySpotRemove", dayIndex: 0, spotIndex: 1 });
  const day = (next.itinerary as Array<Record<string, unknown>>)[0]!;
  assert.deepEqual((day.spots as Array<Record<string, unknown>>).map((spot) => [spot.name, spot.relation]), [
    ["甲", "and"], ["午餐", "and"], ["乙", "or"], ["X", "or"],
  ]);
  const receipt = ((next.manualReview as Record<string, unknown>).itinerarySpotRemovals as Array<Record<string, unknown>>)[0]!;
  assert.equal(receipt.groupKey, alternativeGroupKey(1, ["甲", "X"]));
});
