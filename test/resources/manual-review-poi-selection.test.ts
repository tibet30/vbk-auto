import assert from "node:assert/strict";
import test from "node:test";
import {
  screenManualPoiCandidates,
  verifyManualPoiSelection,
} from "../../src/main/operations/manual-review-poi-selection.ts";

const product = {
  basicInfo: { destinationCity: "西安", province: "陕西", userIdea: "城固张骞故里" },
  itinerary: [{
    day: 1,
    title: "汉中至城固张骞故里",
    description: "前往城固张骞故里",
    spots: [{ name: "张骞故里", poiName: null, poiId: null }],
  }],
};

const detail = {
  httpStatus: 200,
  businessStatus: "Success",
  poiListCount: 2,
  best: { poiName: "张骞公园-张骞纪念馆", poiId: 38513254 },
  candidates: [
    { index: 0, poiName: "张骞公园-张骞纪念馆", poiId: 38513254, province: "新疆", city: "喀什地区", district: "喀什市", selectable: true, textFields: [] },
    { index: 1, poiName: "张骞纪念馆", poiId: 151283243, province: "陕西", city: "汉中", district: "城固", selectable: true, textFields: [] },
  ],
};

test("手动 POI 候选保留展示，但外省候选不可选择且不能成为 best", () => {
  const screened = screenManualPoiCandidates(product, 0, 0, detail);
  assert.equal(screened.candidates[0]?.selectable, false);
  assert.equal(screened.candidates[1]?.selectable, true);
  assert.equal(screened.best, null);
});

test("手动 POI 保存拒绝外省候选，并用当前平台候选重建合法写入", () => {
  assert.throws(() => verifyManualPoiSelection(product, {
    field: "itinerarySpotPoi", dayIndex: 0, spotIndex: 0,
    poiName: "张骞公园-张骞纪念馆", poiId: 38513254,
    province: "陕西", city: "汉中", district: "城固",
  }, detail), /地域约束不匹配/);

  const verified = verifyManualPoiSelection(product, {
    field: "itinerarySpotPoi", dayIndex: 0, spotIndex: 0,
    poiName: "伪造名称", poiId: 151283243,
    province: "新疆", city: "喀什", district: "喀什市",
  }, detail);
  assert.deepEqual(verified, {
    field: "itinerarySpotPoi", dayIndex: 0, spotIndex: 0,
    poiName: "张骞纪念馆", poiId: 151283243,
    province: "陕西", city: "汉中", district: "城固",
  });
});
