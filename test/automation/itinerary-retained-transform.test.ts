import test from "node:test";
import assert from "node:assert/strict";
import { buildDayDescription, buildReadbackExpectations, type ProductItineraryDay } from "../../src/main/automation/ctrip/itinerary-api/itinerary-transform.js";
import { RETAINED_TEXT_ONLY_POI_REMARK } from "../../src/shared/itinerary-activity-kind.js";
import { materializeRetainedItinerary } from "../../src/main/automation/automation.main/itinerary-retained-text.js";
import { checkReadbackActivities, checkReadbackTimeline } from "../../src/main/automation/ctrip/itinerary-api/readback-activities.js";

const day = (): ProductItineraryDay => ({
  day: 2, title: "江孜古迹与羊湖冰川景观线", description: "按原顺序游览", hotel: "无", meals: "含早餐、午餐、晚餐",
  spots: [
    { name: "卡若拉冰川", kind: "attraction", poiId: 91485, poiName: "卡若拉冰川", timeOfDay: "afternoon" },
    { name: "羊卓雍湖", kind: "attraction", poiId: null, poiName: null, timeOfDay: "afternoon", description: "从岗巴拉山口俯瞰湖面", remark: RETAINED_TEXT_ONLY_POI_REMARK },
    { name: "扎什伦布寺", kind: "attraction", poiId: 76348, poiName: "扎什伦布寺", timeOfDay: "afternoon" },
  ],
});
const build = (value: ProductItineraryDay) => buildDayDescription({ day: value, index: 1, totalDays: 3, operations: {}, stations: {} });

test("旧文字保留景点必须先绑定真实 POI，绑定后保留原时段与顺序", () => {
  const unresolved = day(); const unresolvedBefore = structuredClone(unresolved);
  assert.throws(() => build(unresolved), /缺 poiId\/poiName/);
  assert.deepEqual(unresolved, unresolvedBefore);
  const input = day(); const before = structuredClone(input);
  Object.assign(input.spots![1], { poiId: 78569, poiName: "羊卓雍湖" });
  Object.assign(before.spots![1], { poiId: 78569, poiName: "羊卓雍湖" });
  const result = build(input);
  const visits = result.tourDailyInfos.filter(info => [3, 9].includes(Number((info.activeType as { key: number }).key)));
  assert.equal(visits.length, 1);
  assert.deepEqual((visits[0].tourDailyPois as any[]).map(poi => poi.poi.poiId), [91485, 78569, 76348]);
  const expected = buildReadbackExpectations({ itinerary: [input], operations: {}, stations: {} }).days[0];
  assert.deepEqual(expected.pois.map(poi => poi.poiId), [91485, 78569, 76348]);
  assert.deepEqual(expected.timeline.map(entry => entry.kind), ["attraction"]);
  assert.equal(expected.activities.length, 0);
  checkReadbackActivities("第2天", expected.activities, result.tourDailyInfos);
  checkReadbackTimeline("第2天", expected.timeline, result.tourDailyInfos);
  assert.throws(() => checkReadbackTimeline("第2天", expected.timeline,
    result.tourDailyInfos.filter(info => info !== visits[0])));
  assert.deepEqual(input, before);
});

test("未明确保留的缺失 POI 仍然阻断写入", () => {
  const input = day(); delete input.spots![1].remark;
  assert.throws(() => build(input), /缺 poiId\/poiName/);
});

test("旧研究任务确认不能绕过转换阶段的真实 POI 校验", () => {
  const input = day(); delete input.spots![1].remark;
  const retained = materializeRetainedItinerary({ itinerary: [input] }, [{
    state: "confirmed", type: "vbk", label: "核查 羊卓雍湖 的 VBK POI 映射", detail: RETAINED_TEXT_ONLY_POI_REMARK,
  }]);
  assert.equal(retained.changed, true);
  assert.throws(() => build((retained.product.itinerary as ProductItineraryDay[])[0]), /缺 poiId\/poiName/);
});
