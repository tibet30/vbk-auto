import test from "node:test";
import assert from "node:assert/strict";

import { buildBoundarySegment, recoverPendingTrafficLineSegmentSubmit, selectTrafficLineValidationCities, trafficLineModifyUserFromState, trafficLineResourceCheckDates, waitForSegmentSubmit, withTraffic } from "../../src/main/automation/ctrip/traffic-line/segments.ts";

test("资源边界只提交平台接受的最小 DTO，不带旧段只读字段；轮询有明确上限", async () => {
  const boundary = buildBoundarySegment({ productId: 7, segmentId: 8, segmentBase: { keep: "yes" }, opaque: "drop" }, 1, { cityId: 0, cityName: "多出发" }, { cityId: 9, cityName: "大理" });
  assert.deepEqual(Object.keys(boundary).sort(), ["productId", "segmentBase", "segmentId"]);
  assert.equal(boundary.productId, 7);
  assert.deepEqual(boundary.segmentBase, {
    departureAdjustDays: 0, segmentNumber: 1,
    departureCity: { cityId: 0, cityName: "多出发" }, destinationCity: { cityId: 9, cityName: "大理" },
  });

  const originalFetch = globalThis.fetch;
  const originalDocument = (globalThis as { document?: unknown }).document;
  const results = ["U", "T"];
  (globalThis as { document?: unknown }).document = { cookie: "GUID=traffic-test" };
  globalThis.fetch = (async () => new Response(JSON.stringify({ ResponseStatus: { Ack: "Success", Errors: [] }, result: results.shift() }), { status: 200 })) as typeof fetch;
  const waits: number[] = [];
  try {
    await waitForSegmentSubmit({ evaluate: async (fn, arg) => fn(arg) } as any, "child-1", {
      maxPolls: 2,
      sleep: async (milliseconds) => { waits.push(milliseconds); },
    });
    assert.deepEqual(waits, [500]);
  } finally {
    globalThis.fetch = originalFetch;
    (globalThis as { document?: unknown }).document = originalDocument;
  }
});

test("资源校验失败时返回平台明确拒绝的城市，供安全过滤后重提", async () => {
  const originalFetch = globalThis.fetch;
  const originalDocument = (globalThis as { document?: unknown }).document;
  (globalThis as { document?: unknown }).document = { cookie: "GUID=traffic-test" };
  globalThis.fetch = (async () => new Response(JSON.stringify({
    ResponseStatus: { Ack: "Success", Errors: [] },
    result: "F",
    messages: ["部分城市没有资源"],
    checkSegmentResultCities: [{ city: { cityId: 19 } }, { city: { cityId: 19 } }, { city: { cityId: 28 } }],
  }), { status: 200 })) as typeof fetch;
  try {
    assert.deepEqual(
      await waitForSegmentSubmit({ evaluate: async (fn, arg) => fn(arg) } as any, "child-1", { maxPolls: 1 }),
      ["19", "28"],
    );
  } finally {
    globalThis.fetch = originalFetch;
    (globalThis as { document?: unknown }).document = originalDocument;
  }
});

test("交通资源校验使用满足提前预订的近期真实班期", () => {
  const dates = trafficLineResourceCheckDates({
    commercial: { inventory: { startDate: "2026-09-09", endDate: "2027-09-09", dailyQuota: 30 } },
  }, new Date("2026-09-09T10:00:00+08:00"));

  assert.equal(dates[0], "2026-09-11");
  assert.equal(dates.length, 3);
  assert.equal(dates[1], "2026-09-12");
  assert.equal(dates.at(-1), "2026-09-13");
  assert.deepEqual(trafficLineResourceCheckDates({ commercial: { inventory: { startDate: "bad", endDate: "2026-09-09" } } }), []);
});

test("交通资源校验只提交 VBK 热门且具备对应交通能力的城市", () => {
  const groups = [
    { category: "热门", departureCities: [
      { cityId: 1, cityName: "北京", hasAirport: false, hasTrain: false },
      { cityId: 2, cityName: "上海", hasAirport: false, hasTrain: false },
      { cityId: 92, cityName: "日喀则", hasAirport: false, hasTrain: false },
    ] },
    { category: "B", departureCities: [{ cityId: 1, cityName: "北京", countryId: 1, hasAirport: true, hasTrain: true }] },
    { category: "R", departureCities: [{ cityId: 92, cityName: "日喀则", countryId: 1, hasAirport: true, hasTrain: true }] },
    { category: "S", departureCities: [{ cityId: 2, cityName: "上海", countryId: 1, hasAirport: true, hasTrain: true }] },
    { category: "国际热门", departureCities: [{ cityId: 73, cityName: "新加坡", countryId: 3, hasAirport: true, hasTrain: false }] },
    { category: "A", departureCities: [{ cityId: 97, cityName: "阿里", countryId: 1, hasAirport: true, hasTrain: false }] },
  ];

  assert.deepEqual(
    selectTrafficLineValidationCities(groups, "flightRoundTrip", { cityId: 92, cityName: "日喀则" })
      .map((city) => city.cityName),
    ["北京", "上海"],
  );
});

test("班期校验记录尚未可见时只轮询结果，不重复提交资源", async () => {
  const originalFetch = globalThis.fetch;
  const originalDocument = (globalThis as { document?: unknown }).document;
  const payloads = [{
    ResponseStatus: { Ack: "Failure", Errors: [{ Message: "产品班期校验结果不存在，请确认班期校验已经开始。child-1" }] },
  }, {
    ResponseStatus: { Ack: "Success", Errors: [] }, result: "U",
  }, {
    ResponseStatus: { Ack: "Success", Errors: [] }, result: "T",
  }];
  (globalThis as { document?: unknown }).document = { cookie: "GUID=traffic-test" };
  globalThis.fetch = (async () => new Response(JSON.stringify(payloads.shift()), { status: 200 })) as typeof fetch;
  const waits: number[] = [];
  try {
    assert.deepEqual(await waitForSegmentSubmit(
      { evaluate: async (fn, arg) => fn(arg) } as any,
      "child-1",
      { maxPolls: 3, sleep: async (milliseconds) => { waits.push(milliseconds); } },
    ), []);
    assert.deepEqual(waits, [500, 1_000]);
    assert.equal(payloads.length, 0);
  } finally {
    globalThis.fetch = originalFetch;
    (globalThis as { document?: unknown }).document = originalDocument;
  }
});

test("班期校验记录持续不存在时短路停止，不伪装成长时运行中", async () => {
  const originalFetch = globalThis.fetch;
  const originalDocument = (globalThis as { document?: unknown }).document;
  let reads = 0;
  (globalThis as { document?: unknown }).document = { cookie: "GUID=traffic-test" };
  globalThis.fetch = (async () => {
    reads += 1;
    return new Response(JSON.stringify({
      ResponseStatus: { Ack: "Failure", Errors: [{ Message: "产品班期校验结果不存在，请确认班期校验已经开始。child-1" }] },
    }), { status: 200 });
  }) as typeof fetch;
  const waits: number[] = [];
  try {
    await assert.rejects(() => waitForSegmentSubmit(
      { evaluate: async (fn, arg) => fn(arg) } as any,
      "child-1",
      { maxPolls: 210, sleep: async (milliseconds) => { waits.push(milliseconds); } },
    ), /未启动班期校验.*可安全重试/);
    assert.equal(reads, 5);
    assert.deepEqual(waits, [500, 1_000, 1_500, 1_500]);
  } finally {
    globalThis.fetch = originalFetch;
    (globalThis as { document?: unknown }).document = originalDocument;
  }
});

test("班期校验持续进行时一分钟内收口，并持续回传真实轮询进度", async () => {
  const originalFetch = globalThis.fetch;
  const originalDocument = (globalThis as { document?: unknown }).document;
  let reads = 0;
  const progress: number[] = [];
  (globalThis as { document?: unknown }).document = { cookie: "GUID=traffic-test" };
  globalThis.fetch = (async () => {
    reads += 1;
    return new Response(JSON.stringify({
      ResponseStatus: { Ack: "Success", Errors: [] }, result: "U",
    }), { status: 200 });
  }) as typeof fetch;
  try {
    await assert.rejects(() => waitForSegmentSubmit(
      { evaluate: async (fn, arg) => fn(arg) } as any,
      "child-1",
      { sleep: async () => {}, onProgress: (attempt) => { progress.push(attempt); } },
    ), /仍在 VBK 异步核验.*未重复提交/);
    assert.equal(reads, 40);
    assert.deepEqual(progress, [1, 10, 20, 30, 40]);
  } finally {
    globalThis.fetch = originalFetch;
    (globalThis as { document?: unknown }).document = originalDocument;
  }
});

test("恢复时继续只读轮询上一次班期校验，不重复提交", async () => {
  const originalFetch = globalThis.fetch;
  const originalDocument = (globalThis as { document?: unknown }).document;
  const urls: string[] = [];
  let reads = 0;
  (globalThis as { document?: unknown }).document = { cookie: "GUID=traffic-test" };
  globalThis.fetch = (async (input) => {
    urls.push(String(input));
    reads += 1;
    return new Response(JSON.stringify({
      ResponseStatus: { Ack: "Success", Errors: [] }, result: "U",
    }), { status: 200 });
  }) as typeof fetch;
  try {
    assert.equal(await recoverPendingTrafficLineSegmentSubmit(
      { evaluate: async (fn, arg) => fn(arg) } as any,
      "child-1",
      "flightRoundTrip",
      {
        arrivalCity: "日喀则", departureCity: "日喀则", resolvedAt: "2026-09-09T00:00:00.000Z",
        flight: { arrival: { code: "RKZ", name: "和平机场" }, departure: { code: "RKZ", name: "和平机场" } },
      },
      { maxPolls: 3, sleep: async () => {} },
    ), "pending");
    assert.equal(reads, 4);
    assert.match(urls[0]!, /getSubmitSegmentsResult/);
    assert.ok(!urls.some((url) => /\/submitSegments(?:\?|$)/.test(url)));
  } finally {
    globalThis.fetch = originalFetch;
    (globalThis as { document?: unknown }).document = originalDocument;
  }
});

test("恢复只读轮询读到成功后继续正式资源段回读", async () => {
  const originalFetch = globalThis.fetch;
  const originalDocument = (globalThis as { document?: unknown }).document;
  const urls: string[] = [];
  let submitReads = 0;
  const productSegments = {
    productDepartureCity: { departureCities: [{ cityId: 101, cityName: "成都" }] },
    segments: [
      {
        segmentBase: { departureCity: { cityId: 0, cityName: "多出发" }, destinationCity: { cityId: 92, cityName: "日喀则" } },
        flight: { systemFlight: { arrivalAirport: "RKZ", departureAirport: "" } },
      },
      {
        segmentBase: { departureCity: { cityId: 92, cityName: "日喀则" }, destinationCity: { cityId: 0, cityName: "多到达" } },
        flight: { systemFlight: { arrivalAirport: "", departureAirport: "RKZ" } },
      },
    ],
  };
  (globalThis as { document?: unknown }).document = { cookie: "GUID=traffic-test" };
  globalThis.fetch = (async (input) => {
    const url = String(input);
    urls.push(url);
    if (/getSubmitSegmentsResult/.test(url)) {
      submitReads += 1;
      return new Response(JSON.stringify({
        ResponseStatus: { Ack: "Success", Errors: [] }, result: submitReads < 2 ? "U" : "T",
      }), { status: 200 });
    }
    if (/getSegments/.test(url)) {
      return new Response(JSON.stringify({
        ResponseStatus: { Ack: "Success", Errors: [] },
        productSegments,
      }), { status: 200 });
    }
    throw new Error(`unexpected url ${url}`);
  }) as typeof fetch;
  try {
    assert.equal(await recoverPendingTrafficLineSegmentSubmit(
      { evaluate: async (fn, arg) => fn(arg) } as any,
      "child-1",
      "flightRoundTrip",
      {
        arrivalCity: "日喀则", departureCity: "日喀则", resolvedAt: "2026-09-09T00:00:00.000Z",
        flight: { arrival: { code: "RKZ", name: "和平机场" }, departure: { code: "RKZ", name: "和平机场" } },
      },
      { maxPolls: 3, sleep: async () => {} },
    ), "recovered");
    assert.equal(submitReads, 2);
    assert.ok(urls.some((url) => /getSegments/.test(url)));
    assert.ok(!urls.some((url) => /\/submitSegments(?:\?|$)/.test(url)));
  } finally {
    globalThis.fetch = originalFetch;
    (globalThis as { document?: unknown }).document = originalDocument;
  }
});

test("新资源段按参考协议补齐飞机和火车 DTO，并写入接口已核实的站码", () => {
  const endpoints = {
    arrivalCity: "日喀则", departureCity: "日喀则", resolvedAt: "2026-09-03T00:00:00.000Z",
    flight: { arrival: { code: "RKZ", name: "和平机场" }, departure: { code: "RKZ", name: "和平机场" } },
    train: { arrival: { code: "CN001RKO", name: "日喀则", resourceKey: "92" }, departure: { code: "CN001RKO", name: "日喀则", resourceKey: "92" } },
  };
  const enteringFlight = withTraffic({ segmentBase: {} }, "flightRoundTrip", "enter", endpoints);
  assert.equal((enteringFlight.flight as any).systemFlight.arrivalAirport, "RKZ");
  assert.equal((enteringFlight.flight as any).systemFlight.departureAirport, "");
  const leavingTrain = withTraffic({ segmentBase: {} }, "trainRoundTrip", "leave", endpoints);
  assert.deepEqual((leavingTrain.train as any).systemTrain.startStation, { key: "92", value: "" });
  assert.deepEqual((leavingTrain.train as any).systemTrain.startStations, ["日喀则"]);
  assert.deepEqual((leavingTrain.train as any).systemTrain.destinationStation, { key: "0", value: "" });
});

test("资源模块提交账号只取当前页面会话，不使用历史硬编码账号", () => {
  assert.equal(trafficLineModifyUserFromState({
    userInfo: { user: { account: "vbk_current", name: "vbk_fallback" } },
  }), "vbk_current");
  assert.equal(trafficLineModifyUserFromState({
    userInfo: { user: { name: "vbk_fallback" } },
  }), "vbk_fallback");
  assert.throws(() => trafficLineModifyUserFromState({ userInfo: {} }), /当前会话操作账号/);
});
