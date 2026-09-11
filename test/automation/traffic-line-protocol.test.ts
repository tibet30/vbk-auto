import test from "node:test";
import assert from "node:assert/strict";

import {
  assertTrafficLineAck,
  getTrafficLineEditorState,
  parseInitialState,
} from "../../src/main/automation/ctrip/traffic-line/client.ts";
import { buildSaveProductClausesRequest, desiredFirstTabClauses, mergeTrafficLineClauseItems, selectedClauseItems } from "../../src/main/automation/ctrip/traffic-line/clauses.ts";
import { applyRequiredPoiRiskPlans, currentTrafficLineTourInfoId, mergeTrafficNodes, verifyTrafficNodes, waitForTrafficLineItineraryReadback } from "../../src/main/automation/ctrip/traffic-line/itinerary.ts";
import {
  buildBoundarySegment,
  recoverPendingTrafficLineSegmentSubmit,
  selectTrafficLineValidationCities,
  trafficLineModifyUserFromState,
  trafficLineResourceCheckDates,
  waitForSegmentSubmit,
  withTraffic,
} from "../../src/main/automation/ctrip/traffic-line/segments.ts";
import { ensureTrafficLineApi, invalidateTrafficLineFinalReadback } from "../../src/main/automation/ctrip/traffic-line/main.ts";
import { ensureTrafficLinePhase, invalidateTrafficLineWorkflowVerification, trafficLineConfigForProduct } from "../../src/main/automation/ctrip/traffic-line/run-phase.ts";
import { waitForStableReadbackGroup } from "../../src/main/automation/ctrip/traffic-line/stability.ts";
import { attachPlaywrightSessionFetch } from "../../src/main/infrastructure/vbk-session-fetch-adapter.ts";

test("线路及交通编辑页通过当前页面会话读取 initial state，不使用静态 CID", async () => {
  let requested = "";
  const state = await getTrafficLineEditorState({
    evaluate: async () => { throw new Error("不应走裸页面 fetch"); },
    vbkSessionGetText: async (request) => {
      requested = request.endpoint;
      return { status: 200, text: '<script>window.__INITIAL_STATE__ = {"childList":[{"subProductId":12,"lineDescription":"飞机往返"}]};</script>' };
    },
  }, "parent-7");
  assert.match(requested, /trafficLineEdit\?productid=parent-7/);
  assert.deepEqual(state.childList, [{ subProductId: 12, lineDescription: "飞机往返" }]);
});

test("缺少 BrowserView 会话适配器时不发请求，明确保留安全重试入口", async () => {
  let calls = 0;
  await assert.rejects(() => getTrafficLineEditorState({
    evaluate: async () => { calls += 1; throw new Error("不应调用页面 fetch"); },
  }, "parent-7"), /缺少当前 BrowserView 会话适配器/);
  assert.equal(calls, 0);
});

test("线路页只读请求遇到会话鉴权失败时在同一会话有界重试", async () => {
  let calls = 0;
  const state = await getTrafficLineEditorState({
    evaluate: async () => undefined,
    vbkSessionGetText: async () => {
      calls += 1;
      if (calls === 1) return { status: 401, text: "" };
      return { status: 200, text: '<script>window.__INITIAL_STATE__ = {"childList":[]};</script>' };
    },
  }, "parent-7");
  assert.deepEqual(state.childList, []);
  assert.equal(calls, 2);
});

test("独立 live E2E 的重试适配器复用同一 BrowserContext Cookie", async () => {
  let postedUrl = "";
  let postedBody = "";
  let postedHeaders: Record<string, string> = {};
  const request = {
    fetch: async (url: string, options: { data?: string; headers?: Record<string, string> }) => {
      postedUrl = url;
      postedBody = options.data ?? "";
      postedHeaders = options.headers ?? {};
      return {
        status: () => 200,
        text: async () => JSON.stringify({ ResponseStatus: { Ack: "Success" }, value: 1 }),
      };
    },
    get: async () => ({ status: () => 200, text: async () => "<html>ok</html>" }),
  };
  const page = {
    url: () => "https://vbooking.ctrip.com/ivbk/vendor/trafficLineEdit?productid=parent-7",
    evaluate: async (fn: (arg: unknown) => unknown, arg: unknown) => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async () => new Response("<html>ok</html>", { status: 200 })) as typeof fetch;
      try { return await fn(arg); } finally { globalThis.fetch = originalFetch; }
    },
    context: () => ({
      cookies: async () => [{ name: "GUID", value: "live-cid" }, { name: "UBT_VID", value: "live-ubt" }],
      request,
    }),
  } as any;
  attachPlaywrightSessionFetch(page);

  const result = await page.vbkSessionFetch({
    endpoint: "https://online.ctrip.com/restapi/soa2/test",
    body: { head: { cid: "" }, value: 1 },
    errorLabel: "live E2E 测试",
    headers: { "content-type": "application/json" },
    includeCidQuery: true,
    requireReadableCid: true,
  });
  assert.equal(result.ctx.hasCid, true);
  assert.match(postedUrl, /_fxpcqlniredt=live-cid/);
  assert.equal(JSON.parse(postedBody).head.cid, "live-cid");
  assert.equal(postedHeaders["x-ctx-ubt-vid"], "live-ubt");
  assert.match(postedHeaders["user-agent"], /^[\x20-\x7E]+$/);

  const html = await page.vbkSessionGetText({ endpoint: "https://vbooking.ctrip.com/test", errorLabel: "读取" });
  assert.deepEqual(html, { status: 200, text: "<html>ok</html>" });
});

test("初始状态、Ack 和业务错误均严格校验", () => {
  assert.throws(() => parseInitialState("<html></html>", "测试页"), /缺少 window/);
  assert.deepEqual(
    parseInitialState('<script>window.__INITIAL_STATE__ = {"text":"} ; window.fake","childList":[]}\nwindow.__APP_SETTINGS__={}</script>', "测试页"),
    { text: "} ; window.fake", childList: [] },
  );
  assert.throws(
    () => assertTrafficLineAck({ ResponseStatus: { Ack: "Success", Errors: [{ ErrorCode: "20018030", Message: "bad" }] } }, "写入"),
    /20018030: bad/,
  );
  assert.throws(() => assertTrafficLineAck({ ResponseStatus: { Ack: "Warning" } }, "写入"), /Ack=Warning/);
  assert.deepEqual(assertTrafficLineAck({ ResponseStatus: { Ack: "Success", Errors: [] }, data: {} }, "写入").data, {});
});

test("条款合并只补充/覆盖目标条款，保留既有非交通条款", () => {
  const result = mergeTrafficLineClauseItems([
    { clauseItemId: 7, secondClassTypeId: 1, elementDtos: [{ componentCode: "old", value: "keep" }] },
    { clauseItemId: 3035, secondClassTypeId: 86, elementDtos: [{ componentCode: "traffic0", value: "旧值" }] },
  ], [{
    clauseItemId: 3035,
    secondClassTypeId: 86,
    elementDtos: [{ componentCode: "traffic0", value: "往返" }],
  }, {
    clauseItemId: 2041,
    secondClassTypeId: 86,
    elementDtos: [{ componentCode: "transfer", value: "已含" }],
  }]);
  assert.deepEqual(result.map((item) => item.clauseItemId), [7, 3035, 2041]);
  assert.equal((result[0]?.elementDtos as Array<{ value: string }>)[0]?.value, "keep");
  assert.equal((result[1]?.elementDtos as Array<{ value: string }>)[0]?.value, "往返");
});

test("条款提取覆盖容器内住宿项，并把枚举值转换为平台保存 DTO", () => {
  const result = selectedClauseItems({
    clauseTypeDtos: [{
      clauseTypeId: 2,
      clauseItemDtos: [{ clauseItemId: 10092, selected: "F", clauseComponentDtos: [] }],
      containers: [{ clauseItemDtos: [{
        clauseItemId: 10095,
        selected: "T",
        clauseComponentDtos: [{
          componentCode: "hoteltype",
          value: "B",
          componentElementDtos: [{ elementCode: "B", elementValue: "2人" }],
        }],
      }] }],
    }],
  });
  assert.deepEqual(result, [{
    clauseItemId: 10095,
    secondClassTypeId: 2,
    elementDtos: [{ componentCode: "hoteltype", value: "2人", elementCode: "B" }],
  }]);
});

test("交通子产品只复用自身自动交通 schema，并补入实时唯一接送机条款", () => {
  const clausePackage = {
    clauseTypeDtos: [{
      clauseTypeId: 86,
      clauseTypeName: "交通",
      clauseItemDtos: [{
        clauseItemId: 38725,
        selected: "T",
        clauseComponentDtos: [{ componentCode: "go", value: "去程机票" }],
      }, {
        clauseItemId: 38739,
        selected: "T",
        clauseComponentDtos: [{ componentCode: "back", value: "返程机票" }],
      }],
    }, {
      clauseTypeId: 316,
      clauseTypeName: "接送",
      clauseItemDtos: [{
        clauseItemId: 33006,
        selected: "F",
        clauseComponentDtos: [{ componentCode: "transfer", value: "目的地接送机" }],
      }],
    }],
  };
  const result = desiredFirstTabClauses(
    clausePackage,
    selectedClauseItems(clausePackage),
    "flightRoundTrip",
  );
  assert.deepEqual(result.at(-1), {
    clauseItemId: 33006,
    secondClassTypeId: 316,
    elementDtos: [{ componentCode: "transfer", value: "目的地接送机" }],
  });
  assert.deepEqual(result.slice(0, 2).map((item) => item.clauseItemId), [38725, 38739]);
});

test("条款绑定请求使用平台要求的 packageId 与 saveType 协议", () => {
  assert.deepEqual(buildSaveProductClausesRequest("77984347", "202629199", 1), {
    packageId: 202629199,
    saveType: 3,
    productId: "77984347",
    tabEnum: 1,
    clauseEditDtos: [],
    unBookingRuleDtos: [],
  });
});

test("行程交通按 activeType 语义合并，不覆盖中间 POI，单日补齐双节点", () => {
  const firstTransport = { activeType: { key: 2, name: "航班" }, title: "去程" };
  const lastTransport = { activeType: { key: 2, name: "航班" }, title: "回程" };
  const merged = mergeTrafficNodes({
    tourDailyDescriptions: [
      { tourDailyInfos: [{ activeType: { key: 3, name: "景点" }, tourDailyPois: [{ poi: { poiId: 1 } }] }] },
      { tourDailyInfos: [{ activeType: { key: 3, name: "景点" }, tourDailyPois: [{ poi: { poiId: 2 } }] }] },
    ],
  }, firstTransport, lastTransport, "flightRoundTrip");
  const days = merged.tourDailyDescriptions as Array<{ tourDailyInfos: Array<{ activeType: { key: number }; tourDailyPois?: unknown[] }> }>;
  assert.equal(days[0]?.tourDailyInfos[0]?.activeType.key, 2);
  assert.equal(days[1]?.tourDailyInfos.at(-1)?.activeType.key, 2);
  assert.equal(days[0]?.tourDailyInfos[1]?.tourDailyPois?.length, 1);
  assert.equal(verifyTrafficNodes(merged, "flightRoundTrip"), 2);

  const oneDay = mergeTrafficNodes({ tourDailyDescriptions: [{ tourDailyInfos: [] }] }, firstTransport, lastTransport, "flightRoundTrip");
  assert.equal(verifyTrafficNodes(oneDay, "flightRoundTrip"), 2);
});

test("飞机交通节点在资源提交前补齐航班信息卡片", () => {
  const endpoints = {
    arrivalCity: "日喀则",
    departureCity: "日喀则",
    resolvedAt: "2026-09-11T00:00:00.000Z",
    flight: {
      arrival: { code: "RKZ", name: "和平机场" },
      departure: { code: "RKZ", name: "和平机场" },
    },
  };
  const merged = mergeTrafficNodes({
    tourDailyDescriptions: [
      { tourDailyInfos: [{ activeType: { key: 3, name: "景点" }, tourDailyPois: [{ poi: { poiId: 1 } }] }] },
      { tourDailyInfos: [{ activeType: { key: 3, name: "景点" }, tourDailyPois: [{ poi: { poiId: 2 } }] }] },
    ],
  }, { activeType: { key: 2, name: "航班" }, title: "去程" }, { activeType: { key: 2, name: "航班" }, title: "回程" }, "flightRoundTrip", endpoints);

  const days = merged.tourDailyDescriptions as Array<{ tourDailyInfos: Array<Record<string, any>> }>;
  const outbound = days[0]!.tourDailyInfos[0]!;
  const inbound = days[1]!.tourDailyInfos.at(-1)!;
  assert.equal(outbound.tourDailyPackageFlights[0].arriveAirports[0].code, "RKZ");
  assert.equal(inbound.tourDailyPackageFlights[0].departureAirports[0].code, "RKZ");
  assert.equal(verifyTrafficNodes(merged, "flightRoundTrip"), 2);
});

test("飞机行程回读缺少航班信息卡片时不能视为完成", () => {
  assert.throws(() => verifyTrafficNodes({
    tourDailyDescriptions: [
      { tourDailyInfos: [{ activeType: { key: 2, name: "航班" }, tourDailyFlights: [] }] },
      { tourDailyInfos: [{ activeType: { key: 2, name: "航班" }, tourDailyFlights: [] }] },
    ],
  }, "flightRoundTrip"), /缺少首日或末日目标交通节点/);
});

test("火车交通节点在资源提交前补齐火车信息卡片", () => {
  const endpoints = {
    arrivalCity: "日喀则",
    departureCity: "日喀则",
    resolvedAt: "2026-09-11T00:00:00.000Z",
    train: {
      arrival: { code: "CN001RKO", name: "日喀则", resourceKey: "92" },
      departure: { code: "CN001RKO", name: "日喀则", resourceKey: "92" },
    },
  };
  const merged = mergeTrafficNodes({
    tourDailyDescriptions: [
      { tourDailyInfos: [{ activeType: { key: 3, name: "景点" }, tourDailyPois: [{ poi: { poiId: 1 } }] }] },
      { tourDailyInfos: [{ activeType: { key: 3, name: "景点" }, tourDailyPois: [{ poi: { poiId: 2 } }] }] },
    ],
  }, { activeType: { key: 14, name: "火车" }, title: "去程" }, { activeType: { key: 14, name: "火车" }, title: "回程" }, "trainRoundTrip", endpoints);

  const days = merged.tourDailyDescriptions as Array<{ tourDailyInfos: Array<Record<string, any>> }>;
  const outbound = days[0]!.tourDailyInfos[0]!;
  const inbound = days[1]!.tourDailyInfos.at(-1)!;
  assert.equal(outbound.tourDailyPackageTrains[0].arriveTrainStations[0].stationName, "日喀则");
  assert.equal(inbound.tourDailyPackageTrains[0].departureTrainStations[0].stationName, "日喀则");
  assert.equal(verifyTrafficNodes(merged, "trainRoundTrip"), 2);
});

test("火车行程回读缺少火车信息卡片时不能视为完成", () => {
  assert.throws(() => verifyTrafficNodes({
    tourDailyDescriptions: [
      { tourDailyInfos: [{ activeType: { key: 14, name: "火车" }, tourDailyTrains: [] }] },
      { tourDailyInfos: [{ activeType: { key: 14, name: "火车" }, tourDailyTrains: [] }] },
    ],
  }, "trainRoundTrip"), /缺少首日或末日目标交通节点/);
});

test("行程保存后按同一绑定 ID 有界轮询，直到交通节点正式可见", async () => {
  let calls = 0;
  const waits: number[] = [];
  const result = await waitForTrafficLineItineraryReadback(async () => {
    calls += 1;
    return calls === 1
      ? { tourInfoId: "tour-9", tourInfo: { tourDailyDescriptions: [{ tourDailyInfos: [] }] } }
      : {
          tourInfoId: "tour-9",
          tourInfo: {
            tourDailyDescriptions: [
              { tourDailyInfos: [{ activeType: { key: 2, name: "航班" }, tourDailyPackageFlights: [{}] }] },
              { tourDailyInfos: [{ activeType: { key: 2, name: "航班" }, tourDailyPackageFlights: [{}] }] },
            ],
          },
        };
  }, "tour-9", "flightRoundTrip", {
    maxPolls: 2,
    sleep: async (milliseconds) => { waits.push(milliseconds); },
  });
  assert.deepEqual(result, { days: 2, transportNodes: 2 });
  assert.deepEqual(waits, [500]);
});

test("行程只读轮询不能用其它 tourInfoId 的节点冒充当前保存结果", async () => {
  await assert.rejects(() => waitForTrafficLineItineraryReadback(async () => ({
    tourInfoId: "stale-tour",
    tourInfo: { tourDailyDescriptions: [{ tourDailyInfos: [{ activeType: { key: 2 } }] }] },
  }), "saved-tour", "flightRoundTrip", { maxPolls: 1 }), /当前绑定行程 ID=stale-tour/);
});

test("交通子产品以当前 tourInfoId 为准，旧 audit 行程不能冒充当前绑定", () => {
  assert.equal(currentTrafficLineTourInfoId({
    tourInfo: {
      tourInfoId: "current-without-nodes",
      auditTourInfoId: "old-audit-with-nodes",
      previewTourInfoId: "preview",
    },
    tourInfoId: "old-audit-with-nodes",
    isNew: false,
  }), "current-without-nodes");
  assert.equal(currentTrafficLineTourInfoId({
    tourInfo: { tourInfoId: 0, auditTourInfoId: "old-audit-with-nodes" },
    tourInfoId: "old-audit-with-nodes",
    isNew: false,
  }), "");
});

test("整组稳定门捕获后续漂移，定向修复后重新连续核验", async () => {
  const states = ["stable-a", "missing", "stable-b", "stable-b"];
  const waits: number[] = [];
  let repairs = 0;
  let finalCheckpoints = 0;
  const result = await waitForStableReadbackGroup([{ id: "flight" }], {
    key: (item) => item.id,
    verify: async () => {
      const state = states.shift();
      if (state === "missing") throw new Error("known-missing-nodes");
      return { tourInfoId: state };
    },
    signature: (_item, readback) => readback.tourInfoId ?? "",
    canRepair: (error) => error instanceof Error && error.message === "known-missing-nodes",
    repair: async () => { repairs += 1; },
  }, {
    intervalMs: 30_000,
    requiredConsecutive: 2,
    maxSamples: 4,
    sleep: async (milliseconds) => { waits.push(milliseconds); },
  });
  finalCheckpoints += 1;
  assert.deepEqual(result, [{ tourInfoId: "stable-b" }]);
  assert.equal(repairs, 1);
  assert.equal(finalCheckpoints, 1);
  assert.deepEqual(waits, [30_000, 30_000, 30_000, 30_000]);
});

test("稳定门不把会话失败当成可修复业务缺失，也不接受二次漂移", async () => {
  let repairs = 0;
  await assert.rejects(() => waitForStableReadbackGroup([{ id: "train" }], {
    key: (item) => item.id,
    verify: async () => { throw new Error("当前用户未登录"); },
    signature: () => "unused",
    canRepair: () => false,
    repair: async () => { repairs += 1; },
  }, { intervalMs: 0, sleep: async () => {} }), /当前用户未登录/);
  assert.equal(repairs, 0);

  const states = ["missing", "stable", "missing"];
  await assert.rejects(() => waitForStableReadbackGroup([{ id: "train" }], {
    key: (item) => item.id,
    verify: async () => {
      const state = states.shift();
      if (state === "missing") throw new Error("known-missing-nodes");
      return state;
    },
    signature: (_item, readback) => readback ?? "",
    canRepair: (error) => error instanceof Error && error.message === "known-missing-nodes",
    repair: async () => { repairs += 1; },
  }, { intervalMs: 0, maxSamples: 3, sleep: async () => {} }), /known-missing-nodes/);
  assert.equal(repairs, 1);
});

test("默认稳定门覆盖 90 秒窗口，前两次成功后的漂移不能提前完成", async () => {
  const states = ["old", "old", "missing", "new", "new", "new"];
  let repairs = 0;
  const waits: number[] = [];
  const result = await waitForStableReadbackGroup([{ id: "flight" }], {
    key: (item) => item.id,
    verify: async () => {
      const state = states.shift();
      if (state === "missing") throw new Error("known-missing-nodes");
      return state;
    },
    signature: (_item, readback) => readback ?? "",
    canRepair: (error) => error instanceof Error && error.message === "known-missing-nodes",
    repair: async () => { repairs += 1; },
  }, {
    maxSamples: 6,
    sleep: async (milliseconds) => { waits.push(milliseconds); },
  });
  assert.deepEqual(result, ["new"]);
  assert.equal(repairs, 1);
  assert.deepEqual(waits, [30_000, 30_000, 30_000, 30_000, 30_000, 30_000]);
});

test("重验开始原子撤销历史 finalReadback 与 verifiedAt", () => {
  const child = invalidateTrafficLineFinalReadback({
    variant: "flightRoundTrip",
    lineDescription: "飞机往返",
    childProductId: "child-1",
    completedStages: ["planned", "childCreated", "activated", "finalReadback"],
    verified: true,
  });
  assert.deepEqual(child.completedStages, ["planned", "childCreated", "activated"]);
  assert.equal(child.verified, false);

  const workflow = invalidateTrafficLineWorkflowVerification({
    children: [child],
    verifiedAt: "2026-09-03T00:00:00.000Z",
    failureReason: "旧错误",
  });
  assert.equal(workflow.verifiedAt, undefined);
  assert.equal(workflow.failureReason, undefined);
});

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

test("交通资源校验使用覆盖产品库存窗口的代表性真实班期", () => {
  const dates = trafficLineResourceCheckDates({
    commercial: { inventory: { startDate: "2026-09-09", endDate: "2027-09-09", dailyQuota: 30 } },
  }, new Date("2026-09-09T10:00:00+08:00"));

  assert.equal(dates[0], "2026-09-09");
  assert.equal(dates.length, 3);
  assert.equal(dates[1], "2027-03-10");
  assert.equal(dates.at(-1), "2027-09-08");
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

test("交通子产品保存行程时按费用口径唯一补齐风险 POI 备选方案", () => {
  const source = {
    tourDailyDescriptions: [{ tourDailyInfos: [{ costInclude: false, tourDailyPois: [{
      riskPlanCode: "",
      riskPlanDesc: "",
      poi: {
        poiId: 75682,
        poiName: "秦始皇帝陵博物院(兵马俑)",
        isRisk: true,
        riskPlanList: [
          { riskPlanCode: "75682-T-1", riskPlanDesc: "含票方案", costInclude: "T" },
          { riskPlanCode: "75682-F-1", riskPlanDesc: "不含票方案", costInclude: "F" },
        ],
      },
    }] }] }],
  };
  const result = applyRequiredPoiRiskPlans(source as any);
  const dailyPoi = (result.tourDailyDescriptions as any)[0].tourDailyInfos[0].tourDailyPois[0];
  assert.equal(dailyPoi.riskPlanCode, "75682-F-1");
  assert.equal(dailyPoi.riskPlanDesc, "不含票方案");
  assert.equal((source.tourDailyDescriptions as any)[0].tourDailyInfos[0].tourDailyPois[0].riskPlanCode, "");
});

test("风险 POI 备选方案不能唯一确认时安全阻断", () => {
  assert.throws(() => applyRequiredPoiRiskPlans({
    tourDailyDescriptions: [{ tourDailyInfos: [{ costInclude: false, tourDailyPois: [{
      poi: { poiId: 1, poiName: "风险景点", isRisk: true, riskPlanList: [
        { riskPlanCode: "A", riskPlanDesc: "方案一", costInclude: "T" },
        { riskPlanCode: "B", riskPlanDesc: "方案二", costInclude: "A" },
      ] },
    }] }] }],
  }), /无法唯一确认备选方案/);
});

test("同一平台适用口径有多个风险方案时采用 VBK 默认优先项", () => {
  const result = applyRequiredPoiRiskPlans({
    tourDailyDescriptions: [{ tourDailyInfos: [{ costInclude: false, tourDailyPois: [{
      poi: { poiName: "陕西历史博物馆", isRisk: true, riskPlanList: [
        { riskPlanCode: "75684-A-1", riskPlanDesc: "平台首选方案", costInclude: "A" },
        { riskPlanCode: "75684-A-2", riskPlanDesc: "平台次选方案", costInclude: "A" },
      ] },
    }] }] }],
  });
  const dailyPoi = (result.tourDailyDescriptions as any)[0].tourDailyInfos[0].tourDailyPois[0];
  assert.equal(dailyPoi.riskPlanCode, "75684-A-1");
});

test("缺少已核实行程时，完整流水线在任何远端读取/写入前失败", async () => {
  let calls = 0;
  await assert.rejects(() => ensureTrafficLineApi({
    evaluate: async () => { calls += 1; throw new Error("不应调用"); },
  }, "parent-1", { enabled: true, variants: ["flightRoundTrip"] }), /缺少已核实的行程/);
  assert.equal(calls, 0);
});

test("运行阶段不能绕过行程证据门并把部分子产品标记完成", async () => {
  let calls = 0;
  await assert.rejects(() => ensureTrafficLinePhase({
    page: { evaluate: async () => { calls += 1; throw new Error("不应调用"); } },
    parentProductId: "parent-1",
    config: { enabled: true, variants: ["trainRoundTrip"] },
    log: () => {},
  }), /缺少已核实的行程/);
  assert.equal(calls, 0);
});

test("执行阶段保留已确认的火车配置，交由平台资源阶段判断可售性", () => {
  assert.deepEqual(
    trafficLineConfigForProduct(
      { enabled: true, variants: ["flightRoundTrip", "trainRoundTrip"] },
      { basicInfo: { meetingCity: "日喀则市", destinationCity: "日喀则" }, operations: { pickupCity: "日喀则" } },
    ),
    { enabled: true, variants: ["flightRoundTrip", "trainRoundTrip"] },
  );
});
