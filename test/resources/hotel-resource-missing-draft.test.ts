import assert from "node:assert/strict";
import test from "node:test";
import { ensureHotelResourceApi } from "../../src/main/automation/ctrip/hotel-resource-api.js";

const city = (cityId: number, cityName: string) => ({
  cityId,
  cityName,
  countryId: 1,
  countryName: "中国",
  provinceId: 22,
  provinceName: "四川",
});

const candidates = (start: number, cityId: number, cityName: string) => Array.from({ length: 5 }, (_, index) => ({
  hotelId: start + index,
  hotelName: `${cityName}酒店${index + 1}`,
  diamond: 5,
  distanceKm: index + 1,
  cityName,
  anchorCityId: cityId,
}));

test("已有指定酒店但拒绝保存前后内容未变化时，恢复草稿并保留原绑定", async () => {
  const oldFetch = globalThis.fetch;
  const oldDocument = (globalThis as any).document;
  const rikaze = city(100, "日喀则");
  let createdDraft = false;
  let saveAttempts = 0;
  let segment: any = {
    segmentId: "lodging-1", productId: 78159725,
    segmentBase: { segmentNumber: 2, departureCity: rikaze, destinationCity: rikaze, stayNights: 1, minStayNights: 1, maxStayNights: 1, deleteable: true },
    hotel: { segmentRooms: [{ masterHotelID: 100, hotelName: "已保存酒店", squenceNumber: 5 }] },
  };
  const fullTrip = { ...segment, hotel: { segmentRooms: [] }, segmentId: "full-trip", segmentBase: { ...segment.segmentBase, segmentNumber: 1, stayNights: 0, minStayNights: 0, maxStayNights: 0, deleteable: false } };
  const terminal = { ...segment, hotel: { segmentRooms: [] }, segmentId: "terminal", segmentBase: { ...segment.segmentBase, segmentNumber: 3, stayNights: 0, minStayNights: 0, maxStayNights: 0 } };
  (globalThis as any).document = { cookie: "GUID=fixture" };
  globalThis.fetch = (async (input: any, init?: any) => {
    const endpoint = new URL(String(input)).pathname;
    if (endpoint.endsWith("createProductDraft")) createdDraft = true;
    if (endpoint.endsWith("saveSegment")) {
      saveAttempts += 1;
      if (!createdDraft) return new Response(JSON.stringify({ ResponseStatus: { Ack: "Failure", Errors: [{ ErrorCode: "20016116", Message: "产品还没有创建草稿。" }] } }), { status: 200 });
      segment = JSON.parse(String(init?.body ?? "{}")).segment;
    }
    const payload = endpoint.endsWith("getSegments")
      ? { ResponseStatus: { Ack: "Success" }, draftProductSegments: { segments: [fullTrip, segment, terminal] } }
      : { ResponseStatus: { Ack: "Success" } };
    return new Response(JSON.stringify(payload), { status: 200 });
  }) as typeof fetch;
  try {
    const result = await ensureHotelResourceApi(
      { evaluate: async (fn: any, arg: any) => fn(arg) },
      { operations: { hotelTier: "当地4钻酒店/-4", hotelResource: { source: "ctrip" } }, itinerary: [{ day: 1, hotel: "日喀则酒店1", hotelCandidates: candidates(100, 100, "日喀则") }] },
      "78159725",
    );
    assert.equal(result.verified, true);
    assert.equal(saveAttempts, 2);
    assert.deepEqual(segment.hotel.segmentRooms.map((room: any) => room.masterHotelID), [100, 101, 102, 103, 104]);
  } finally {
    globalThis.fetch = oldFetch;
    if (oldDocument === undefined) delete (globalThis as any).document;
    else (globalThis as any).document = oldDocument;
  }
});
