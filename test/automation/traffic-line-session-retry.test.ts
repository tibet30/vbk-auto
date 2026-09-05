import test from "node:test";
import assert from "node:assert/strict";

import { postTrafficLineSoa } from "../../src/main/automation/ctrip/traffic-line/client.ts";
import { publishedSegmentReadbackIsComplete, validatedSegmentReadbackIsComplete } from "../../src/main/automation/ctrip/traffic-line/segments.ts";
import { departureCityReadbackIsComplete, validatedDepartureCityReadbackIsComplete } from "../../src/main/automation/ctrip/traffic-line/segment-departure-cities.ts";
import { postSoa } from "../../src/main/automation/ctrip/itinerary-api/transport.ts";

test("明确的会话未登录 Ack 仅在同一 BrowserView 会话中有界重试", async () => {
  const originalFetch = globalThis.fetch;
  const originalDocument = (globalThis as { document?: unknown }).document;
  let calls = 0;
  (globalThis as { document?: unknown }).document = { cookie: "GUID=traffic-test" };
  globalThis.fetch = (async () => {
    calls += 1;
    const payload = calls === 1
      ? { ResponseStatus: { Ack: "Failure", Errors: [{ Message: "当前用户未登录" }] } }
      : { ResponseStatus: { Ack: "Success", Errors: [] }, value: "verified" };
    return new Response(JSON.stringify(payload), { status: 200 });
  }) as typeof fetch;
  try {
    const result = await postTrafficLineSoa(
      { evaluate: async (fn, arg) => fn(arg) } as any,
      "15638",
      "readSomething",
      { productId: "child-1" },
      "会话重试测试",
    );
    assert.equal(result.value, "verified");
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
    (globalThis as { document?: unknown }).document = originalDocument;
  }
});

test("非会话 Ack 错误不盲目重提", async () => {
  const originalFetch = globalThis.fetch;
  const originalDocument = (globalThis as { document?: unknown }).document;
  let calls = 0;
  (globalThis as { document?: unknown }).document = { cookie: "GUID=traffic-test" };
  globalThis.fetch = (async () => {
    calls += 1;
    return new Response(JSON.stringify({
      ResponseStatus: { Ack: "Failure", Errors: [{ Message: "必选条款有更新未保存" }] },
    }), { status: 200 });
  }) as typeof fetch;
  try {
    await assert.rejects(() => postTrafficLineSoa(
      { evaluate: async (fn, arg) => fn(arg) } as any,
      "15638",
      "writeSomething",
      { productId: "child-1" },
      "业务失败测试",
    ), /必选条款有更新未保存/);
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
    (globalThis as { document?: unknown }).document = originalDocument;
  }
});

test("交通 POST 的 HTTP 会话拒绝未接受写入时允许同会话重试", async () => {
  const originalFetch = globalThis.fetch;
  const originalDocument = (globalThis as { document?: unknown }).document;
  let calls = 0;
  (globalThis as { document?: unknown }).document = { cookie: "GUID=traffic-test" };
  globalThis.fetch = (async () => {
    calls += 1;
    return calls === 1
      ? new Response("unauthorized", { status: 401 })
      : new Response(JSON.stringify({ ResponseStatus: { Ack: "Success", Errors: [] } }), { status: 200 });
  }) as typeof fetch;
  try {
    await postTrafficLineSoa(
      { evaluate: async (fn, arg) => fn(arg) } as any,
      "15638", "writeSomething", { productId: "child-1" }, "会话 HTTP 重试测试",
    );
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
    (globalThis as { document?: unknown }).document = originalDocument;
  }
});

test("行程 API 的明确未登录 Ack 采用相同的安全重试语义", async () => {
  const originalFetch = globalThis.fetch;
  const originalDocument = (globalThis as { document?: unknown }).document;
  let calls = 0;
  (globalThis as { document?: unknown }).document = { cookie: "GUID=traffic-test" };
  globalThis.fetch = (async () => {
    calls += 1;
    const payload = calls === 1
      ? { ResponseStatus: { Ack: "Failure", Errors: [{ Message: "当前用户未登录" }] } }
      : { ResponseStatus: { Ack: "Success", Errors: [] }, value: "ok" };
    return new Response(JSON.stringify(payload), { status: 200 });
  }) as typeof fetch;
  try {
    const result = await postSoa(
      { evaluate: async (fn, arg) => fn(arg) } as any,
      "https://online.ctrip.com/restapi/soa2/test",
      { productId: "child-1" },
      "行程会话重试测试",
    );
    assert.equal(result.payload.value, "ok");
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
    (globalThis as { document?: unknown }).document = originalDocument;
  }
});

test("资源模块响应超时只能由正式资源回读消除歧义", () => {
  const endpoints = {
    arrivalCity: "南京", departureCity: "南京", resolvedAt: "2026-09-04T00:00:00.000Z",
    flight: { arrival: { code: "NKG", name: "禄口国际机场" }, departure: { code: "NKG", name: "禄口国际机场" } },
    train: { arrival: { code: "CN001NJH", name: "南京", resourceKey: "12" }, departure: { code: "CN001NJH", name: "南京", resourceKey: "12" } },
  };
  const segments = [
    { segmentBase: { departureCity: { cityId: 0 } }, flight: { systemFlight: { arrivalAirport: "NKG" } } },
    { segmentBase: { destinationCity: { cityId: 0 } }, flight: { systemFlight: { departureAirport: "NKG" } } },
  ];
  const departureCities = [{ cityId: 4, cityName: "重庆" }];
  assert.equal(publishedSegmentReadbackIsComplete({
    productSegments: { segments, productDepartureCity: { departureCities } },
  }, "flightRoundTrip", endpoints, departureCities), true);
  assert.equal(publishedSegmentReadbackIsComplete({ draftProductSegments: { segments } }, "flightRoundTrip", endpoints), false);
  assert.equal(publishedSegmentReadbackIsComplete({ productSegments: { segments, productDepartureCity: {} } }, "flightRoundTrip", endpoints), false);
  assert.equal(departureCityReadbackIsComplete({
    productSegments: { productDepartureCity: { departureCities } },
  }, departureCities), true);
});

test("班期校验后的正式出发城市可被平台过滤，但不能为空或混入未提交城市", () => {
  const endpoints = {
    arrivalCity: "大理", departureCity: "大理", resolvedAt: "2026-09-04T00:00:00.000Z",
    flight: { arrival: { code: "DLU", name: "凤仪机场" }, departure: { code: "DLU", name: "凤仪机场" } },
    train: { arrival: { code: "CN001DKM", name: "大理", resourceKey: "669326" }, departure: { code: "CN001DKM", name: "大理", resourceKey: "669326" } },
  };
  const segments = [
    { segmentBase: { departureCity: { cityId: 0 } }, train: { systemTrain: { destinationStation: { key: "669326" }, destinationStations: ["大理"] } } },
    { segmentBase: { destinationCity: { cityId: 0 } }, train: { systemTrain: { startStation: { key: "669326" }, startStations: ["大理"] } } },
  ];
  const submitted = [{ cityId: 4 }, { cityId: 12 }, { cityId: 28 }];
  const filtered = { productSegments: { segments, productDepartureCity: { departureCities: [{ cityId: 12 }] } } };
  assert.equal(validatedDepartureCityReadbackIsComplete(filtered, submitted), true);
  assert.equal(validatedSegmentReadbackIsComplete(filtered, "trainRoundTrip", endpoints, submitted), true);
  assert.equal(validatedSegmentReadbackIsComplete({
    productSegments: { segments, productDepartureCity: {} },
  }, "trainRoundTrip", endpoints, submitted), false);
  assert.equal(validatedDepartureCityReadbackIsComplete({
    productSegments: { productDepartureCity: { departureCities: [{ cityId: 99 }] } },
  }, submitted), false);
});
