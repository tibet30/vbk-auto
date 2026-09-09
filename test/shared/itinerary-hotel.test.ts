import assert from "node:assert/strict";
import test from "node:test";
import { hasItineraryHotelStay } from "../../src/shared/itinerary-hotel.js";

test("明确的无住宿标记不算酒店晚", () => {
  assert.equal(hasItineraryHotelStay("无"), false);
  assert.equal(hasItineraryHotelStay("  无  "), false);
  assert.equal(hasItineraryHotelStay("本日无住宿"), false);
  assert.equal(hasItineraryHotelStay("本日不住宿"), false);
  assert.equal(hasItineraryHotelStay("当日无住宿"), false);
  assert.equal(hasItineraryHotelStay("无需住宿"), false);
  assert.equal(hasItineraryHotelStay("当日返程，不安排住宿"), false);
  assert.equal(hasItineraryHotelStay("返程，无需酒店"), false);
  assert.equal(hasItineraryHotelStay("本日无住宿（行程结束送站）"), false);
  assert.equal(hasItineraryHotelStay("本日无住宿(行程结束送站)"), false);
  assert.equal(hasItineraryHotelStay(""), false);
});

test("实际酒店名称算住宿晚", () => {
  assert.equal(hasItineraryHotelStay("维也纳酒店(江孜宗山古堡店)"), true);
  assert.equal(hasItineraryHotelStay("无锡君来洲际酒店"), true);
});
