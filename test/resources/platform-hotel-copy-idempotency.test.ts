import assert from "node:assert/strict";
import test from "node:test";
import { cleanPlatformHotelCopy } from "../../src/shared/platform-hotel-copy.js";
import { normalisePlatformHotelProduct, PLATFORM_HOTEL_DESCRIPTION } from "../../src/shared/platform-hotel-rules.js";

test("生成的酒店文案与重复提取的酒店名称不会反复扩张", () => {
  const original = { basicInfo: { meetingCity: "广安", days: 2, nights: 1,
    userIdea: "广安动车站—巴人石头城—丽枫酒店\n丽枫酒店—邓小平故里—送站" },
    itinerary: [{ day: 1, hotel: "丽枫酒店", title: "动车站—白塔公园—丽枫酒店",
      description: "游览白塔公园后送至丽枫酒店办理入住。",
      activities: [{ type: "transport", title: "送至丽枫酒店", detail: "丽枫酒店办理入住" }] },
    { day: 2, hotel: "无当日住宿安排", title: "丽枫酒店—邓小平故里—送站",
      description: "早餐后从丽枫酒店出发，游览邓小平故里后送站。" }] };
  const expected = normalisePlatformHotelProduct(original);
  let current = expected;
  for (let index = 0; index < 40; index++) {
    current = normalisePlatformHotelProduct(current);
    assert.deepEqual(current, expected);
  }
  assert.equal(expected.itinerary[0].title, "动车站—白塔公园—平台酒店");
  assert.equal(expected.itinerary[1].title, "平台酒店—邓小平故里—送站");
});

test("酒店名称去重且不会匹配平台酒店描述的子串", () => {
  const source = `送至平台酒店，住宿：${PLATFORM_HOTEL_DESCRIPTION}。`;
  const names = Array(50).fill("平台酒店").concat("酒店", "五钻酒店", PLATFORM_HOTEL_DESCRIPTION);
  assert.equal(cleanPlatformHotelCopy(source, names), source);
  assert.equal(cleanPlatformHotelCopy("送至丽枫酒店", Array(50).fill("丽枫酒店")), `送至${PLATFORM_HOTEL_DESCRIPTION}`);
});

test("长行程文本没有酒店距离条件时保持原文", { timeout: 2000 }, () => {
  const source = "游览白塔公园".repeat(100000);
  assert.equal(cleanPlatformHotelCopy(source), source);
});

test("删除住宿限制保留同句景点与交通距离", () => {
  assert.equal(cleanPlatformHotelCopy("游览青城山后入住当地民宿"), "游览青城山后平台自动匹配酒店");
  assert.equal(cleanPlatformHotelCopy("酒店出发专车行驶30公里游览青城山"), "酒店出发专车行驶30公里游览青城山");
  assert.equal(cleanPlatformHotelCopy("游览青城山后住宿距景区5公里"), `游览青城山后${PLATFORM_HOTEL_DESCRIPTION}`);
  const normalized = normalisePlatformHotelProduct({ basicInfo: { meetingCity: "成都", nights: 1 },
    itinerary: [{ day: 1, hotel: "当地民宿", title: "游览青城山后入住当地民宿" }] });
  assert.match(normalized.itinerary[0].title, /游览青城山后/);
});

test("平台自动匹配会清除旧的指定酒店来源和档次", () => {
  const normalized = normalisePlatformHotelProduct({
    basicInfo: { meetingCity: "成都", nights: 1 },
    operations: {
      hotelMatchingMode: "rules",
      hotelRules: { autoMatch: true, grades: [3, 4, 5] },
      hotelSource: "nonPlatform",
      hotelTier: "当地5钻酒店/-38",
    },
    itinerary: [{ day: 1, hotel: "旧酒店" }],
  });
  assert.equal(normalized.operations.hotelMatchingMode, "rules");
  assert.deepEqual(normalized.operations.hotelRules, { autoMatch: true, grades: [3, 4, 5] });
  assert.equal(normalized.operations.hotelSource, undefined);
  assert.equal(normalized.operations.hotelTier, undefined);
});
