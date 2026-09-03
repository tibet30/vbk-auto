import assert from "node:assert/strict";
import test from "node:test";
import {
  ensureResourceSegmentsDraftApi,
  ensureVehicleResourceBinding,
} from "../../src/main/automation/ctrip/vehicle-resource-api.js";

test("酒店阶段可复用资源草稿初始化，不依赖后续用车阶段", async () => {
  const oldFetch = globalThis.fetch;
  const oldDocument = (globalThis as any).document;
  const calls: string[] = [];
  let draftCreated = false;
  (globalThis as any).document = { cookie: "GUID=fixture" };
  globalThis.fetch = (async (input: any, init?: any) => {
    const endpoint = new URL(String(input)).pathname;
    calls.push(endpoint);
    if (endpoint.endsWith("createProductDraft")) draftCreated = true;
    const payload = endpoint.endsWith("getSegments")
      ? {
        ResponseStatus: { Ack: "Success" },
        ...(draftCreated
          ? { draftProductSegments: { segments: [{ segmentId: "full-trip" }] } }
          : { productSegments: { segments: [{ segmentId: "full-trip" }] } }),
      }
      : { ResponseStatus: { Ack: "Success" } };
    return new Response(JSON.stringify(payload), { status: 200 });
  }) as typeof fetch;
  try {
    const payload = await ensureResourceSegmentsDraftApi(
      { evaluate: async (fn: any, arg: any) => fn(arg) },
      "77977327",
    );
    assert.deepEqual(payload.draftProductSegments.segments, [{ segmentId: "full-trip" }]);
    assert.deepEqual(calls, [
      "/restapi/soa2/15638/getSegments",
      "/restapi/soa2/15638/saveProductMaintainType",
      "/restapi/soa2/15638/createProductDraft",
      "/restapi/soa2/15638/getSegments",
    ]);
  } finally {
    globalThis.fetch = oldFetch;
    if (oldDocument === undefined) delete (globalThis as any).document;
    else (globalThis as any).document = oldDocument;
  }
});

test("用车资源仅保留在全程首段，并清除住宿段上的历史绑定", async () => {
  const oldFetch = globalThis.fetch;
  const oldDocument = (globalThis as any).document;
  const calls: Array<{ endpoint: string; segmentId?: string }> = [];
  const vehicleGroup = { resourceGroupId: 9001, resourceGroup: { resourceGroupId: 9001 } };
  const hotelGroup = { resourceGroupId: 8001, resourceGroup: { resourceGroupId: 8001 } };
  let segments: any[] = [
    { segmentId: "full-trip", segmentResourceGroups: [] },
    { segmentId: "hotel-2-nights", segmentResourceGroups: [vehicleGroup, hotelGroup] },
    { segmentId: "hotel-1-night", segmentResourceGroups: [hotelGroup] },
  ];
  (globalThis as any).document = { cookie: "GUID=fixture" };
  globalThis.fetch = (async (input: any, init?: any) => {
    const endpoint = new URL(String(input)).pathname;
    const body = JSON.parse(String(init?.body ?? "{}"));
    calls.push({ endpoint, segmentId: body.segment?.segmentId });
    if (endpoint.endsWith("saveSegment")) {
      segments = segments.map((segment) => String(segment.segmentId) === String(body.segment.segmentId)
        ? body.segment
        : segment);
    }
    const payload = endpoint.endsWith("getSegments")
      ? { ResponseStatus: { Ack: "Success" }, draftProductSegments: { segments } }
      : { ResponseStatus: { Ack: "Success" } };
    return new Response(JSON.stringify(payload), { status: 200 });
  }) as typeof fetch;
  try {
    const result = await ensureVehicleResourceBinding(
      { evaluate: async (fn: any, arg: any) => fn(arg) },
      "77973457",
      9001,
      "测试用车组",
    );
    assert.equal(result.targetSegmentId, "full-trip");
    assert.deepEqual(calls.map((call) => [call.endpoint, call.segmentId]), [
      ["/restapi/soa2/15638/getSegments", undefined],
      ["/restapi/soa2/15638/saveSegment", "full-trip"],
      ["/restapi/soa2/15638/saveSegment", "hotel-2-nights"],
      ["/restapi/soa2/15638/submitSegments", undefined],
      ["/restapi/soa2/15638/getSegments", undefined],
    ]);
    assert.equal(segments[0].segmentResourceGroups.some((group: any) => group.resourceGroupId === 9001), true);
    assert.equal(segments[1].segmentResourceGroups.some((group: any) => group.resourceGroupId === 9001), false);
    assert.equal(segments[1].segmentResourceGroups.some((group: any) => group.resourceGroupId === 8001), true);
  } finally {
    globalThis.fetch = oldFetch;
    if (oldDocument === undefined) delete (globalThis as any).document;
    else (globalThis as any).document = oldDocument;
  }
});
