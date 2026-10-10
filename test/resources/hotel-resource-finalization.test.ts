import assert from "node:assert/strict";
import test from "node:test";
import { ensureHotelResourceApi } from "../../src/main/automation/ctrip/hotel-resource-api.js";

const city = { cityId: 100, cityName: "日喀则", countryId: 1, countryName: "中国", provinceId: 22, provinceName: "西藏" };
const candidates = Array.from({ length: 5 }, (_, index) => ({
  hotelId: 100 + index, hotelName: `日喀则酒店${index + 1}`, cityName: "日喀则", anchorCityId: 100,
}));
const lodging = {
  segmentId: "lodging-1", productId: 78120988,
  segmentBase: { segmentNumber: 2, departureCity: city, destinationCity: city, stayNights: 1, minStayNights: 1, maxStayNights: 1, deleteable: true },
  hotel: { segmentRooms: [] },
};
const initialSegments = () => [
  { ...lodging, segmentId: "full-trip", segmentBase: { ...lodging.segmentBase, segmentNumber: 1, stayNights: 0, minStayNights: 0, maxStayNights: 0, deleteable: false } },
  structuredClone(lodging),
  { ...lodging, segmentId: "terminal", segmentBase: { ...lodging.segmentBase, segmentNumber: 3, stayNights: 0, minStayNights: 0, maxStayNights: 0 } },
];

function fixture(options: { productForm: "groupTour" | "privateTour"; promote?: boolean }) {
  let draft = initialSegments();
  let formal = draft.map((segment) => ({ ...segment, hotel: { segmentRooms: [] } }));
  const calls: string[] = [];
  const oldFetch = globalThis.fetch;
  const oldTimeout = globalThis.setTimeout;
  // 加速有界轮询等待，保留请求超时和实际业务回读判断。
  globalThis.setTimeout = ((callback: any, delay: number, ...args: any[]) =>
    oldTimeout(callback, delay <= 1500 ? 0 : delay, ...args)) as typeof setTimeout;
  const oldDocument = (globalThis as any).document;
  (globalThis as any).document = { cookie: "GUID=fixture" };
  globalThis.fetch = (async (input: any, init?: any) => {
    const endpoint = new URL(String(input)).pathname;
    calls.push(endpoint);
    if (endpoint.endsWith("saveSegment")) {
      const saved = JSON.parse(String(init?.body ?? "{}")).segment;
      draft = draft.map((segment) => String(segment.segmentId) === String(saved.segmentId) ? saved : segment);
    }
    if (endpoint.endsWith("publishProductModules") && options.promote !== false) formal = structuredClone(draft);
    const payload = endpoint.endsWith("getSegments") ? {
      ResponseStatus: { Ack: "Success" },
      draftProductSegments: { segments: structuredClone(draft) },
      productSegments: { segments: structuredClone(formal) },
    } : { ResponseStatus: { Ack: "Success" } };
    return new Response(JSON.stringify(payload), { status: 200 });
  }) as typeof fetch;
  const page = {
    evaluate: async (fn: any, arg: any) => fn(arg),
    vbkSessionGetText: async () => ({ status: 200, text: '<script>window.__INITIAL_STATE__ = {"userInfo":{"user":{"name":"fixture-user"}}};</script>' }),
  };
  const run = () => ensureHotelResourceApi(page, {
    sales: { productForm: options.productForm },
    operations: { hotelTier: "当地5钻酒店/-38" },
    itinerary: [{ day: 1, hotel: "日喀则酒店", hotelCandidates: candidates }],
  }, "78120988");
  const restore = () => {
    globalThis.fetch = oldFetch;
    globalThis.setTimeout = oldTimeout;
    if (oldDocument === undefined) delete (globalThis as any).document;
    else (globalThis as any).document = oldDocument;
  };
  return { calls, restore, run };
}

test("酒店-only 产品发布资源模块一次，并以正式段回读完成", async () => {
  const f = fixture({ productForm: "groupTour", promote: true });
  try {
    const result = await f.run();
    assert.equal(result.finalization.published, true);
    assert.equal(f.calls.filter((endpoint) => endpoint.endsWith("publishProductModules")).length, 1);
    assert.equal(f.calls.some((endpoint) => endpoint.endsWith("submitSegments")), false);
  } finally { f.restore(); }
});

test("私家团酒店阶段保留草稿，等待用车阶段统一发布", async () => {
  const f = fixture({ productForm: "privateTour" });
  try {
    const result = await f.run();
    assert.equal(result.finalization.deferred, true);
    assert.equal(f.calls.some((endpoint) => endpoint.endsWith("publishProductModules")), false);
    assert.equal(f.calls.some((endpoint) => endpoint.endsWith("submitSegments")), false);
  } finally { f.restore(); }
});

test("正确草稿但错误正式段时酒店阶段不能完成", async () => {
  const f = fixture({ productForm: "groupTour", promote: false });
  try {
    await assert.rejects(() => f.run(), /正式资源回读不一致/);
    assert.equal(f.calls.filter((endpoint) => endpoint.endsWith("publishProductModules")).length, 1);
  } finally { f.restore(); }
});
