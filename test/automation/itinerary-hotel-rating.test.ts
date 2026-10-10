import test from "node:test";
import assert from "node:assert/strict";
import { buildDayDescription, buildReadbackExpectations } from "../../src/main/automation/ctrip/itinerary-api/itinerary-transform.ts";

for (const [diamond, ratingType, display] of [
  [0, "diamond", "当地酒店"],
  [2, "homestay", "2钻民宿"],
  [3, "homestay", "3钻民宿"],
  [4, "star", "4星酒店"],
  [3, "diamond", "当地3钻酒店"],
] as const) {
  test(`行程酒店说明与回读保留实际 ${display}，不冒充全程目标`, () => {
    const day = { day: 2, title: "华阳住宿", description: "", hotel: "晓溪山舍", meals: "",
      hotelCandidates: [{ hotelName: "晓溪山舍", diamond, ratingType }],
      activities: [{ time: "下午", title: "自由活动", detail: "古镇自由活动", type: "free" as const, source: "user" as const }] };
    const operations = { hotelTier: "当地5钻酒店/-38" };
    const output = buildDayDescription({ day, index: 1, totalDays: 3, operations, stations: {} });
    const hotel = output.tourDailyInfos.find(info => (info.activeType as { key: number }).key === 1);
    assert.ok(String(hotel?.description).includes(`晓溪山舍（${display}）`));
    assert.ok(!String(hotel?.description).includes("5钻"));
    const expected = buildReadbackExpectations({ itinerary: [day], operations, stations: {} });
    assert.equal(expected.days[0].hotels[0].hotelTier, display);
    assert.equal(operations.hotelTier, "当地5钻酒店/-38");
  });
}

test("当晚已有降档要求而未携带候选时，说明仍保留实际等级类型", () => {
  const day = { day: 2, title: "华阳住宿", description: "", hotel: "晓溪山舍", meals: "",
    hotelRequirement: { anchorName: "华阳古镇", diamond: 2, ratingType: "homestay" as const } };
  const expected = buildReadbackExpectations({ itinerary: [day], operations: { hotelTier: "当地3钻酒店/-3" }, stations: {} });
  assert.equal(expected.days[0].hotels[0].hotelTier, "2钻民宿");
});
