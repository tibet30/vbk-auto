import test from "node:test";
import assert from "node:assert/strict";
import { normaliseItinerarySupport, supportArrangementType } from "../../src/shared/itinerary-support-arrangements.js";
import { normaliseProductDraft } from "../../src/main/data/product-normalize.js";
import { hasValidItinerary } from "../../src/main/automation/automation-contract.helpers.js";
import { itineraryPoisAreComplete } from "../../src/main/planning/runtime.js";
import { validateModuleValue } from "../../src/main/planning/schemas.js";
import { buildTimeline } from "../../src/renderer/app/views/workspace/review-summary-itinerary-timeline.js";
import { transformItinerary, buildReadbackExpectations } from "../../src/main/automation/ctrip/itinerary-api/itinerary-transform.js";
import { applyManualReviewField } from "../../src/main/operations/manual-review-field.js";

export const transferDay = {
  day: 6, title: "汉中送机 / 送高铁 → 返程", description: "早餐后从酒店出发，根据返程安排送至汉中城固机场或汉中站。",
  hotel: "无当日住宿安排", meals: "早餐含；正餐敬请自理。",
  spots: ["汉中市酒店", "汉中城固机场", "汉中站"].map((name) => ({ name, kind: "other" as const, poiId: null, poiName: null })),
};

test("接送酒店机场车站和餐食不进入游览时间线，实际体验仍保留", () => {
  assert.deepEqual(buildTimeline(transferDay, 5), []);
  const day = { ...transferDay, spots: [...transferDay.spots, { name: "藏香制作", kind: "other" as const, poiId: null, poiName: null }] };
  assert.deepEqual(buildTimeline(day, 5).map((item) => ({ title: item.title, spotIndex: item.spotIndex })), [{ title: "藏香制作", spotIndex: 3 }]);
  assert.equal(supportArrangementType({ name: "汉中火车站博物馆", kind: "attraction" }), undefined);
});

test("保存归一化把后勤地点迁出 spots，接送合并且反复保存不重复", () => {
  const day = normaliseItinerarySupport(transferDay);
  assert.deepEqual(day.spots, []);
  assert.equal((day as any).activities.length, 1);
  assert.equal((day as any).activities[0].type, "transport");
  assert.match((day as any).activities[0].detail, /机场或汉中站/);
  assert.deepEqual(normaliseItinerarySupport(day), day);
  const product = normaliseProductDraft({ itinerary: [transferDay] });
  assert.deepEqual((product.itinerary as any[])[0].spots, []);
});

test("有明确接送的无景点日通过所有准入，真正空白日和仅有餐食仍失败", () => {
  const day = normaliseItinerarySupport(transferDay);
  assert.equal(hasValidItinerary({ itinerary: [day] }), true);
  assert.equal(itineraryPoisAreComplete([day]), true);
  assert.equal(validateModuleValue("itinerary", [day]).ok, true);
  const empty = { ...transferDay, spots: [], activities: [] };
  assert.equal(hasValidItinerary({ itinerary: [empty] }), false);
  assert.equal(itineraryPoisAreComplete([empty]), false);
  assert.equal(validateModuleValue("itinerary", [empty]).ok, false);
  const mealsOnly = { ...empty, spots: [{ name: "早餐含", kind: "other" as const }] };
  assert.equal(hasValidItinerary({ itinerary: [mealsOnly] }), false);
  assert.equal(itineraryPoisAreComplete([mealsOnly]), false);
});

test("误放入站点的住宿和早餐进入对应字段，已有正式安排优先", () => {
  const source = { spots: [{ name: "汉中市酒店", kind: "other" }, { name: "早餐含；正餐自理", kind: "other" }] };
  const day = normaliseItinerarySupport(source) as typeof source & { hotel: string; meals: string };
  assert.deepEqual(day.spots, []);
  assert.equal(day.hotel, "汉中市酒店");
  assert.equal(day.meals, "早餐含；正餐自理");
  assert.deepEqual(normaliseItinerarySupport(day), day);
  const confirmed = normaliseItinerarySupport({ ...source, hotel: "已确认酒店", meals: "早餐含" });
  assert.equal(confirmed.hotel, "已确认酒店");
  assert.equal(confirmed.meals, "早餐含");
});

test("VBK接送日只录入接送用车餐食，不创建机场酒店等其他或自由活动节点", () => {
  const args = { itinerary: [transferDay], operations: { pickupCity: "汉中", transport: "charter" as const, mealsIncluded: false },
    stations: { pickupTrain: { type: "train" as const, id: "CN001HZ", code: "CN001HZ", name: "汉中", raw: {} },
      dropoffTrain: { type: "train" as const, id: "CN001HZ", code: "CN001HZ", name: "汉中", raw: {} } } };
  const infos = transformItinerary(args)[0]!.tourDailyInfos;
  assert.ok(!infos.some((info) => [3, 7, 9].includes(Number(info.activeType?.key))));
  const readback = buildReadbackExpectations(args).days[0]!;
  assert.deepEqual(readback.pois, []);
  assert.deepEqual(readback.activities, []);
  assert.deepEqual(readback.timeline, []);
  assert.ok(readback.transport);
});

test("住宿镇、上一晚出发镇和普通餐食迁出站点，真实古镇游览仍保留", () => {
  const source = { description: "早餐后专车离开咀头镇，中午在留坝用餐，傍晚送至留侯镇办理入住。",
    hotel: "隐筑花涧庭院民宿", hotelRequirement: { anchorName: "留侯" }, meals: "早餐含；午餐留坝土席",
    spots: [{ name: "太白县咀头镇", kind: "other" }, { name: "留坝县城美食", kind: "other" },
      { name: "留侯镇", kind: "other" }, { name: "华阳古镇", kind: "attraction", poiId: 145411446, poiName: "华阳古镇" }] };
  const day = normaliseItinerarySupport(source);
  assert.deepEqual(day.spots.map(spot => spot.name), ["华阳古镇"]);
  assert.equal(day.hotel, source.hotel);
  assert.equal(day.meals, source.meals);
  assert.equal((day as any).activities[0].type, "transport");
  assert.deepEqual(normaliseItinerarySupport(day), day);
  assert.deepEqual(buildTimeline(source, 2).map(item => item.title), ["华阳古镇"]);
  const saved = applyManualReviewField({ basicInfo: {}, itinerary: [source] }, { field: "basicInfoSubtitle", subtitle: "秦岭之旅" });
  assert.deepEqual((saved.itinerary as Array<typeof source>)[0].spots.map(spot => spot.name), ["华阳古镇"]);
});
