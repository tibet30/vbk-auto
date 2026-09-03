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

test("新建产品缺少住宿段时，自动按连续城市创建并让停留晚数等于住宿晚数", async () => {
  const oldFetch = globalThis.fetch;
  const oldDocument = (globalThis as any).document;
  const chengdu = city(28, "成都");
  const dujiangyan = city(94, "都江堰");
  const fullTrip = {
    segmentId: "full-trip",
    productId: 77977327,
    packages: [{ packageId: 1 }],
    hotelDays: [],
    segmentResourceGroups: [{ resourceGroupId: 9001 }],
    segmentBase: {
      segmentNumber: 1,
      departureCity: chengdu,
      destinationCity: chengdu,
      stayNights: 3,
      minStayNights: 3,
      maxStayNights: 3,
      deleteable: false,
    },
  };
  const terminal = {
    segmentId: "terminal",
    productId: 77977327,
    packages: [],
    hotelDays: [],
    segmentResourceGroups: [],
    segmentBase: {
      segmentNumber: 2,
      departureCity: chengdu,
      destinationCity: chengdu,
      stayNights: 0,
      minStayNights: 0,
      maxStayNights: 0,
      deleteable: true,
    },
  };
  let segments: any[] = [structuredClone(fullTrip), structuredClone(terminal)];
  let created = 0;
  const newSegmentIds: unknown[] = [];
  (globalThis as any).document = { cookie: "GUID=fixture" };
  globalThis.fetch = (async (input: any, init?: any) => {
    const endpoint = new URL(String(input)).pathname;
    const body = JSON.parse(String(init?.body ?? "{}"));
    if (endpoint.endsWith("suggestDepartureCity")) {
      const match = body.keyword === "成都" ? chengdu : body.keyword === "都江堰" ? dujiangyan : null;
      return new Response(JSON.stringify({ ResponseStatus: { Ack: "Success" }, cities: match ? [match] : [] }), { status: 200 });
    }
    if (endpoint.endsWith("saveSegment")) {
      const draft = structuredClone(body.segment);
      if (Number(draft.segmentId) === 0) {
        newSegmentIds.push(draft.segmentId);
        created += 1;
        draft.segmentId = `lodging-${created}`;
        const insertAt = segments.findIndex((segment) => Number(segment.segmentBase.segmentNumber) >= Number(draft.segmentBase.segmentNumber));
        segments.splice(insertAt < 0 ? segments.length : insertAt, 0, draft);
        segments.forEach((segment, index) => { segment.segmentBase.segmentNumber = index + 1; });
      } else {
        segments = segments.map((segment) => String(segment.segmentId) === String(draft.segmentId) ? draft : segment);
      }
    }
    const payload = endpoint.endsWith("getSegments")
      ? { ResponseStatus: { Ack: "Success" }, draftProductSegments: { segments: structuredClone(segments) } }
      : { ResponseStatus: { Ack: "Success" } };
    return new Response(JSON.stringify(payload), { status: 200 });
  }) as typeof fetch;
  try {
    const result = await ensureHotelResourceApi(
      { evaluate: async (fn: any, arg: any) => fn(arg) },
      {
        operations: { hotelTier: "当地5钻酒店/-38", hotelResource: { source: "ctrip" } },
        itinerary: [
          { day: 1, hotel: "成都酒店1", hotelCandidates: candidates(100, 28, "成都") },
          { day: 2, hotel: "成都酒店1", hotelCandidates: candidates(100, 28, "成都") },
          { day: 3, hotel: "都江堰酒店1", hotelCandidates: candidates(200, 94, "都江堰") },
        ],
      },
      "77977327",
    );

    assert.equal(result.layout.created, 2);
    assert.deepEqual(newSegmentIds, [0, 0]);
    assert.deepEqual(segments.map((segment) => ({
      city: segment.segmentBase.destinationCity.cityName,
      stay: segment.segmentBase.stayNights,
      min: segment.segmentBase.minStayNights,
      max: segment.segmentBase.maxStayNights,
    })), [
      { city: "成都", stay: 0, min: 0, max: 0 },
      { city: "成都", stay: 2, min: 2, max: 2 },
      { city: "都江堰", stay: 1, min: 1, max: 1 },
      { city: "成都", stay: 0, min: 0, max: 0 },
    ]);
    assert.deepEqual(segments[0].segmentResourceGroups, [{ resourceGroupId: 9001 }]);
    assert.deepEqual(segments[1].hotel.segmentRooms.map((room: any) => room.masterHotelID), [100, 101, 102, 103, 104]);
    assert.deepEqual(segments[2].hotel.segmentRooms.map((room: any) => room.masterHotelID), [200, 201, 202, 203, 204]);
  } finally {
    globalThis.fetch = oldFetch;
    if (oldDocument === undefined) delete (globalThis as any).document;
    else (globalThis as any).document = oldDocument;
  }
});
