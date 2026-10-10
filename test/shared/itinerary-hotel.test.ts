import assert from "node:assert/strict";
import test from "node:test";
import { hasItineraryHotelStay, ITINERARY_CTRIP_PLATFORM_HOTEL } from "../../src/shared/itinerary-hotel.js";

test("明确的无住宿标记不算酒店晚", () => {
  assert.equal(hasItineraryHotelStay("无"), false);
  assert.equal(hasItineraryHotelStay("  无  "), false);
  assert.equal(hasItineraryHotelStay("本日无住宿"), false);
  assert.equal(hasItineraryHotelStay("本日不住宿"), false);
  assert.equal(hasItineraryHotelStay("当日无住宿"), false);
  assert.equal(hasItineraryHotelStay("无当日住宿安排"), false);
  assert.equal(hasItineraryHotelStay("无当天住宿安排（汉中送站）"), false);
  assert.equal(hasItineraryHotelStay("无需住宿"), false);
  assert.equal(hasItineraryHotelStay("当日返程，不安排住宿"), false);
  assert.equal(hasItineraryHotelStay("当日行程结束，不安排过夜住宿。"), false);
  assert.equal(hasItineraryHotelStay("当天送站，无需过夜酒店"), false);
  assert.equal(hasItineraryHotelStay("返程，无需酒店"), false);
  for (const hotel of ["返程不住宿", "当日返程不住宿", "返程日不住宿", "送机日不住宿（按班次安排）"]) assert.equal(hasItineraryHotelStay(hotel), false);
  assert.equal(hasItineraryHotelStay("不安排"), false);
  assert.equal(hasItineraryHotelStay("不安排住宿"), false);
  assert.equal(hasItineraryHotelStay("当日不安排酒店（送站）"), false);
  assert.equal(hasItineraryHotelStay("本日无住宿（行程结束送站）"), false);
  assert.equal(hasItineraryHotelStay("本日无住宿(行程结束送站)"), false);
  assert.equal(hasItineraryHotelStay(""), false);
});

test("实际酒店名称算住宿晚", () => {
  assert.equal(hasItineraryHotelStay("维也纳酒店(江孜宗山古堡店)"), true);
  assert.equal(hasItineraryHotelStay("无锡君来洲际酒店"), true);
  assert.equal(hasItineraryHotelStay("返程驿站酒店"), true);
  assert.equal(hasItineraryHotelStay("返程日入住市区酒店"), true);
  assert.equal(hasItineraryHotelStay("安排入住潮州古城酒店"), true);
});

test("行程描述住宿始终使用携程平台酒店，套餐是否含酒店为否", () => {
  assert.equal(ITINERARY_CTRIP_PLATFORM_HOTEL.useSegmentConfig, true);
  assert.equal(ITINERARY_CTRIP_PLATFORM_HOTEL.ishand, true);
  assert.equal(ITINERARY_CTRIP_PLATFORM_HOTEL.packageIsHotelResource, "F");
});
