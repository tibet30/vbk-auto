import assert from "node:assert/strict";
import test from "node:test";
import { inferHotelTierFromUserText, HOTEL_TIER_VALUES } from "../../src/shared/hotel-tiers.js";

test("从用户明确表述推断酒店档次，可覆盖默认 5 钻", () => {
  assert.equal(inferHotelTierFromUserText("住当地4钻酒店"), HOTEL_TIER_VALUES[1]);
  assert.equal(inferHotelTierFromUserText("希望安排三钻住宿"), HOTEL_TIER_VALUES[2]);
  assert.equal(inferHotelTierFromUserText("五星级酒店优先"), HOTEL_TIER_VALUES[0]);
  assert.equal(inferHotelTierFromUserText("当地5钻"), HOTEL_TIER_VALUES[0]);
});

test("未明确档次时不推断，避免误覆盖模板", () => {
  assert.equal(inferHotelTierFromUserText("想轻松一点，适合带孩子"), undefined);
  assert.equal(inferHotelTierFromUserText(""), undefined);
  assert.equal(inferHotelTierFromUserText("多安排博物馆"), undefined);
});
