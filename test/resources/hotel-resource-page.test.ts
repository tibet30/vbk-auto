import assert from "node:assert/strict";
import test from "node:test";
import { hotelIdsFromSegment, syncCtripHotelResources } from "../../src/main/automation/ctrip/hotel-resource-page.js";

test("酒店资源接口回读只认行程段 hotel.segmentRooms 中的酒店 ID", () => {
  const ids = hotelIdsFromSegment({
    hotel: {
      segmentRooms: [
        { masterHotelID: 391650, hotelName: "四川岷山饭店" },
        { masterHotelID: 3455825, hotelName: "成都万达瑞华酒店" },
      ],
    },
  });
  assert.deepEqual(ids, [391650, 3455825]);
  assert.deepEqual(hotelIdsFromSegment({ hotel: { segmentRooms: [] } }), []);
  assert.deepEqual(hotelIdsFromSegment({}), []);
});

test("酒店资源直接以 saveSegment 保存五家指定酒店，并以 getSegments 回读", async () => {
  const previousFetch = globalThis.fetch;
  const previousDocument = (globalThis as any).document;
  const calls: Array<{ endpoint: string; body: any }> = [];
  let segment: any = { segmentId: "s-1", segmentBase: { stayNights: 1 }, hotel: { segmentRooms: [] } };
  (globalThis as any).document = { cookie: "GUID=fixture" };
  globalThis.fetch = (async (input: any, init?: any) => {
    const endpoint = new URL(String(input)).pathname;
    const body = JSON.parse(String(init?.body ?? "{}"));
    calls.push({ endpoint, body });
    if (endpoint === "/restapi/soa2/15638/saveSegment") segment = body.segment;
    const payload = endpoint === "/restapi/soa2/15638/getSegments"
      ? { ResponseStatus: { Ack: "Success" }, draftProductSegments: { segments: [segment] } }
      : { ResponseStatus: { Ack: "Success" } };
    return new Response(JSON.stringify(payload), { status: 200 });
  }) as typeof fetch;
  try {
    const result = await syncCtripHotelResources({
      page: { evaluate: async (fn: any, arg: any) => fn(arg) },
      productId: "77968888",
      dailyCandidates: [{
        day: 1,
        segmentId: "s-1",
        candidates: [1, 2, 3, 4, 5].map((hotelId) => ({ hotelId, hotelName: `酒店${hotelId}` })),
      }],
    });
    assert.equal(result.via, "saveSegment-submitSegments-api");
    assert.deepEqual(calls.map((call) => call.endpoint), [
      "/restapi/soa2/15638/getSegments",
      "/restapi/soa2/15638/saveSegment",
      "/restapi/soa2/15638/submitSegments",
      "/restapi/soa2/15638/getSegments",
    ]);
    assert.deepEqual(hotelIdsFromSegment(segment), [1, 2, 3, 4, 5]);
    assert.equal(calls[1]?.body.segment.hotel.segmentRooms.length, 5);
    assert.deepEqual(calls[1]?.body.segment.hotel.segmentRooms.map((room: any) => room.squenceNumber), [5, 4, 3, 2, 1]);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousDocument === undefined) delete (globalThis as any).document;
    else (globalThis as any).document = previousDocument;
  }
});

test("资源服务回读重排酒店后仍确认已保存，且不会重复保存", async () => {
  const previousFetch = globalThis.fetch;
  const previousDocument = (globalThis as any).document;
  const calls: string[] = [];
  const ordered = [1, 2, 3, 4, 5];
  let segment: any = {
    segmentId: "s-1",
    hotel: { segmentRooms: ordered.slice().reverse().map((masterHotelID) => ({
      masterHotelID,
      squenceNumber: ordered.length - ordered.indexOf(masterHotelID),
    })) },
  };
  (globalThis as any).document = { cookie: "GUID=fixture" };
  globalThis.fetch = (async (input: any) => {
    const endpoint = new URL(String(input)).pathname;
    calls.push(endpoint);
    return new Response(JSON.stringify(endpoint.endsWith("getSegments")
      ? { ResponseStatus: { Ack: "Success" }, productSegments: { segments: [segment] } }
      : { ResponseStatus: { Ack: "Success" } }), { status: 200 });
  }) as typeof fetch;
  try {
    const result = await syncCtripHotelResources({
      page: { evaluate: async (fn: any, arg: any) => fn(arg) },
      productId: "77968888",
      dailyCandidates: [{
        day: 1,
        segmentId: "s-1",
        candidates: ordered.map((hotelId) => ({ hotelId, hotelName: `酒店${hotelId}` })),
      }],
    });
    assert.equal(result.via, "getSegments-api");
    assert.deepEqual(calls, ["/restapi/soa2/15638/getSegments", "/restapi/soa2/15638/getSegments"]);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousDocument === undefined) delete (globalThis as any).document;
    else (globalThis as any).document = previousDocument;
  }
});
