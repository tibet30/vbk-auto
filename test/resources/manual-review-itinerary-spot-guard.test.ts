import test from "node:test";
import assert from "node:assert/strict";
import {
  applyItinerarySpotKind, applyItinerarySpotPoi, applyItinerarySpotRemove,
} from "../../src/main/operations/manual-review-itinerary-field.js";
import { verifyManualPoiSelection } from "../../src/main/operations/manual-review-poi-selection.js";

const ID1 = "sp_0123456789ab";
const ID2 = "sp_ba9876543210";

/** 第 1 天两个景点，spotId 分别为 ID2 / ID1（模拟 Agent 重排后下标 0 已不是原景点）。 */
function product() {
  return {
    itinerary: [{
      day: 1, title: "第一天", activities: [],
      spots: [
        { spotId: ID2, name: "平遥古城", kind: "attraction", poiName: null, poiId: null },
        { spotId: ID1, name: "晋祠", kind: "attraction", poiName: null, poiId: null },
      ],
    }],
  } as Record<string, unknown>;
}
const poiInput = (spotIndex: number, spotId?: string) => ({
  field: "itinerarySpotPoi" as const, dayIndex: 0, spotIndex, poiName: "晋祠", poiId: 123,
  ...(spotId === undefined ? {} : { spotId }),
});
const spotsOf = (value: Record<string, unknown>) =>
  ((value.itinerary as Array<{ spots: Array<Record<string, unknown>> }>)[0]!).spots;

test("spotIndex 处已不是原景点时拒绝删除", () => {
  assert.throws(() => applyItinerarySpotRemove(product(), {
    field: "itinerarySpotRemove", dayIndex: 0, spotIndex: 0, spotId: ID1,
  }), /行程已变更/);
});

test("spotIndex 处已不是原景点时拒绝改类型与绑定 POI", () => {
  assert.throws(() => applyItinerarySpotKind(product(), {
    field: "itinerarySpotKind", dayIndex: 0, spotIndex: 0, kind: "free", spotId: ID1,
  }), /行程已变更/);
  assert.throws(() => applyItinerarySpotPoi(product(), poiInput(0, ID1)), /行程已变更/);
});

test("spotId 一致时正常绑定 POI、改类型与删除", () => {
  const bound = spotsOf(applyItinerarySpotPoi(product(), poiInput(1, ID1)));
  assert.equal(bound[1]!.poiId, 123);
  assert.equal(bound[1]!.spotId, ID1);
  assert.equal(spotsOf(applyItinerarySpotKind(product(), {
    field: "itinerarySpotKind", dayIndex: 0, spotIndex: 1, kind: "free", spotId: ID1,
  }))[1]!.kind, "free");
  const removed = spotsOf(applyItinerarySpotRemove(product(), {
    field: "itinerarySpotRemove", dayIndex: 0, spotIndex: 1, spotId: ID1,
  }));
  assert.deepEqual(removed.map((spot) => spot.spotId), [ID2]);
});

test("未携带 spotId（旧客户端）按原逻辑执行", () => {
  assert.equal(spotsOf(applyItinerarySpotPoi(product(), poiInput(0)))[0]!.poiId, 123);
  assert.equal(spotsOf(applyItinerarySpotRemove(product(), {
    field: "itinerarySpotRemove", dayIndex: 0, spotIndex: 0,
  })).length, 1);
});

test("目标景点本身无 spotId 但请求携带 spotId 时同样拒绝", () => {
  const legacy = { itinerary: [{ day: 1, spots: [{ name: "晋祠", kind: "attraction" }] }] };
  assert.throws(() => applyItinerarySpotRemove(legacy, {
    field: "itinerarySpotRemove", dayIndex: 0, spotIndex: 0, spotId: ID1,
  }), /行程已变更/);
});

test("人工 POI 校验重建写入载荷时保留 spotId", () => {
  const detail = {
    httpStatus: 200, businessStatus: "Success", poiListCount: 1, best: null,
    candidates: [{ index: 0, poiName: "晋祠", poiId: 123, province: "山西", city: "太原", district: "晋源", selectable: true, textFields: [] }],
  };
  const base = { itinerary: [{ day: 1, spots: [{ spotId: ID1, name: "晋祠", kind: "attraction" }] }],
    basicInfo: { destinationCity: "太原", province: "山西", meetingCity: "太原" } };
  const withId = verifyManualPoiSelection(base, { ...poiInput(0, ID1), poiName: "x" }, detail);
  assert.equal(withId.spotId, ID1);
  const withoutId = verifyManualPoiSelection(base, { ...poiInput(0), poiName: "x" }, detail);
  assert.equal("spotId" in withoutId, false);
});
