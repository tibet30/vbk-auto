import test from "node:test";
import assert from "node:assert/strict";
import { syncCtripHotelResources } from "../../src/main/automation/ctrip/hotel-resource-page.js";

test("保存后整份草稿重新编号并复用旧ID，后续酒店仍绑定正确住宿段", async () => {
  const previousFetch = globalThis.fetch; const previousDocument = (globalThis as any).document;
  let segments: any[] = [
    { segmentId: 1, segmentBase: { stayNights: 0 } },
    ...[2, 1, 1].map((stayNights, index) => ({ segmentId: index + 2, segmentBase: { stayNights, destinationCity: { cityName: "汕头" } }, hotel: { segmentRooms: [] } })),
  ];
  let saves = 0; const savedIndexes: number[] = [];
  (globalThis as any).document = { cookie: "GUID=test" };
  globalThis.fetch = (async (input: any, init: any) => {
    const endpoint = new URL(String(input)).pathname; const body = JSON.parse(String(init?.body || "{}"));
    if (endpoint.endsWith("saveSegment")) {
      const index = segments.findIndex(s => s.segmentId === body.segment.segmentId);
      savedIndexes.push(index); segments[index] = body.segment; saves++;
      // 新首段恰好复用原来第二段的ID，不能仅用“旧ID是否存在”判断。
      segments = segments.map((s, index) => ({ ...s, segmentId: saves + 1 + index }));
    }
    return new Response(JSON.stringify({ ResponseStatus: { Ack: "Success" }, ...(endpoint.endsWith("getSegments") ? { draftProductSegments: { segments } } : {}) }), { status: 200 });
  }) as typeof fetch;
  try {
    const result = await syncCtripHotelResources({ page: { evaluate: async (fn: any, arg: any) => fn(arg) }, productId: "1",
      dailyCandidates: [1, 3, 4].map((day, index) => ({ day, segmentId: String(index + 2), candidates: [{ hotelId: 100 + index, hotelName: `酒店${index}` }] })) });
    assert.deepEqual(savedIndexes, [1, 2, 3]);
    assert.deepEqual(segments.slice(1).map(s => s.hotel.segmentRooms[0].masterHotelID), [100, 101, 102]);
    assert.deepEqual(result.days.map(d => d.segmentId), ["5", "6", "7"]);
    assert.equal(result.verified, true);
  } finally { globalThis.fetch = previousFetch; (globalThis as any).document = previousDocument; }
});

test("保存后住宿结构发生变化时停止后续写入，不能仅按旧位置继续", async () => {
  const previousFetch = globalThis.fetch; const previousDocument = (globalThis as any).document;
  let saves = 0;
  let segments = [1, 2].map(segmentId => ({ segmentId, segmentBase: { stayNights: 1 }, hotel: { segmentRooms: [] } }));
  (globalThis as any).document = { cookie: "GUID=test" };
  globalThis.fetch = (async (input: any) => {
    const endpoint = new URL(String(input)).pathname;
    if (endpoint.endsWith("saveSegment")) { saves++; segments = segments.slice(0, 1); }
    return new Response(JSON.stringify({ ResponseStatus: { Ack: "Success" },
      ...(endpoint.endsWith("getSegments") ? { draftProductSegments: { segments } } : {}) }), { status: 200 });
  }) as typeof fetch;
  try {
    await assert.rejects(syncCtripHotelResources({ page: { evaluate: async (fn: any, arg: any) => fn(arg) }, productId: "1",
      dailyCandidates: [1, 2].map(day => ({ day, segmentId: String(day), candidates: [{ hotelId: 100 + day, hotelName: `酒店${day}` }] })) }), /住宿段结构发生变化/);
    assert.equal(saves, 1);
  } finally { globalThis.fetch = previousFetch; (globalThis as any).document = previousDocument; }
});
