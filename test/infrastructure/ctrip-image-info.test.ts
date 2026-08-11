/**
 * 携程图库 getImageInfo 模块的单元测试：
 *  - parseCtripImageInfoPayload 解析 200/500 imageUrls → previewUrl/thumbnailUrl；
 *  - 缺 imageUrls 时回退 originalPath；
 *  - Ack 非 Success 时抛中文错误；
 *  - body 缺失 / 不是数组时返回空 items，不抛错；
 *  - fetchCtripImageInfoMap：imageId → info；去重 + 过滤非正整数。
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  buildCtripImageInfoRequest,
  parseCtripImageInfoPayload,
  fetchCtripImageInfoMap,
  fetchCtripImageInfo,
  GET_IMAGE_INFO_ENDPOINT,
} from "../../src/main/infrastructure/ctrip-image-info.js";
import type { PoiSuggestBrowser } from "../../src/main/infrastructure/poi-suggest.js";
import type { CtripImageInfoLogEvent } from "../../src/main/infrastructure/ctrip-image-info.js";

const successEnvelope = (body: unknown[]) => ({
  ResponseStatus: { Ack: "Success", Errors: [] },
  body,
});

test("parseCtripImageInfoPayload 解析 200 / 500 两档 imageUrls，并保留原始 resolution / score / poiName", () => {
  const payload = successEnvelope([
    {
      imageId: 12345,
      poiId: 79413,
      poiName: "云冈石窟",
      originalPath: "https://images.c-ctrip.com/orig/12345.jpg",
      fileName: "yungang-original.jpg",
      districtName: "云冈区",
      countryName: "中国",
      width: 1280,
      height: 1917,
      noteImgScore: 4.7,
      imageUrls: [
        { url: "https://images.c-ctrip.com/s200/12345.jpg", width: 200, height: 200, type: "thumbnail" },
        { url: "https://images.c-ctrip.com/s500/12345.jpg", width: 500, height: 500, type: "preview" },
        { url: "https://images.c-ctrip.com/o/12345.jpg", width: 1280, height: 1917, type: "original" },
      ],
    },
  ]);
  const response = parseCtripImageInfoPayload(payload, 200);
  assert.equal(response.httpStatus, 200);
  assert.equal(response.businessStatus, "Success");
  assert.equal(response.items.length, 1);
  const item = response.items[0];
  assert.equal(item.imageId, 12345);
  assert.equal(item.poiId, 79413);
  assert.equal(item.poiName, "云冈石窟");
  assert.equal(item.thumbnailUrl, "https://images.c-ctrip.com/s200/12345.jpg");
  assert.equal(item.previewUrl, "https://images.c-ctrip.com/s500/12345.jpg");
  assert.equal(item.originalUrl, "https://images.c-ctrip.com/orig/12345.jpg");
  assert.equal(item.resolution, "1280*1917");
  assert.equal(item.score, 4.7);
  assert.equal(item.fileName, "yungang-original.jpg");
  assert.equal(item.districtName, "云冈区");
  assert.equal(item.countryName, "中国");
  assert.equal(item.imageUrls.length, 3);
});

test("parseCtripImageInfoPayload 缺 imageUrls 时回退 originalPath", () => {
  const payload = successEnvelope([
    {
      imageId: 67890,
      poiName: "西安城墙",
      originalPath: "https://images.c-ctrip.com/orig/67890.jpg",
    },
  ]);
  const response = parseCtripImageInfoPayload(payload);
  assert.equal(response.items.length, 1);
  const item = response.items[0];
  assert.equal(item.thumbnailUrl, "https://images.c-ctrip.com/orig/67890.jpg");
  assert.equal(item.previewUrl, "https://images.c-ctrip.com/orig/67890.jpg");
  assert.equal(item.originalUrl, "https://images.c-ctrip.com/orig/67890.jpg");
  assert.equal(item.resolution, null);
  assert.equal(item.score, null);
});

test("parseCtripImageInfoPayload imageUrls 缺 200 档时按尺寸相近兜底匹配", () => {
  const payload = successEnvelope([
    {
      imageId: 11111,
      originalPath: "https://images.c-ctrip.com/orig/11111.jpg",
      imageUrls: [
        { url: "https://images.c-ctrip.com/m210/11111.jpg", width: 210, height: 210, type: "thumbnail" },
      ],
    },
  ]);
  const response = parseCtripImageInfoPayload(payload);
  const item = response.items[0];
  // 210×210 视为 200×200 的 ±10% 区间兜底
  assert.equal(item.thumbnailUrl, "https://images.c-ctrip.com/m210/11111.jpg");
  // preview 缺 → 回退 originalPath
  assert.equal(item.previewUrl, "https://images.c-ctrip.com/orig/11111.jpg");
});

test("parseCtripImageInfoPayload Ack 非 Success 抛中文错误并包含响应描述", () => {
  const payload = {
    ResponseStatus: {
      Ack: "Failure",
      Errors: [{ Code: "AUTH_EXPIRED", Message: "登录态失效" }],
    },
    body: [],
  };
  assert.throws(() => parseCtripImageInfoPayload(payload), /业务失败/);
  try {
    parseCtripImageInfoPayload(payload);
  } catch (error) {
    assert.match((error as Error).message, /登录态失效/);
  }
});

test("parseCtripImageInfoPayload body 缺失或非数组时返回空 items，不抛错", () => {
  const empty = parseCtripImageInfoPayload(successEnvelope([]));
  assert.equal(empty.items.length, 0);
  const noBody = parseCtripImageInfoPayload({
    ResponseStatus: { Ack: "Success" },
  });
  assert.equal(noBody.items.length, 0);
  const wrongBody = parseCtripImageInfoPayload({
    ResponseStatus: { Ack: "Success" },
    body: { not: "array" },
  });
  assert.equal(wrongBody.items.length, 0);
});

test("parseCtripImageInfoPayload 完全空对象会被丢弃", () => {
  const payload = successEnvelope([
    {}, // 没有任何可识别字段：imageId/poiName/originalPath/imageUrls 全空 → 丢弃
    {
      imageId: 1,
      originalPath: "https://images.c-ctrip.com/orig/1.jpg",
    },
  ]);
  const response = parseCtripImageInfoPayload(payload);
  assert.equal(response.items.length, 1);
  assert.equal(response.items[0].imageId, 1);
});

test("parseCtripImageInfoPayload score 同时支持 number 与字符串", () => {
  const payload = successEnvelope([
    { imageId: 2, noteImgScore: "4.2", originalPath: "https://x/2.jpg" },
    { imageId: 3, tourImgAiScore: 5, originalPath: "https://x/3.jpg" },
  ]);
  const response = parseCtripImageInfoPayload(payload);
  assert.equal(response.items[0].score, 4.2);
  assert.equal(response.items[1].score, 5);
});

test("buildCtripImageInfoRequest 拒绝空 imageIds 并去重 / 过滤非法值", () => {
  const request = buildCtripImageInfoRequest({ cid: "ignored-for-real-fetch", imageIds: [1, "2", 2, 0, -1, 1.5] });
  assert.deepEqual(request.imageIds, [1, 2]);
  assert.throws(() => buildCtripImageInfoRequest({ cid: "", imageIds: [] }), /至少一个 imageId/);
  assert.throws(() => buildCtripImageInfoRequest({ cid: "", imageIds: [0, -1, 1.5] }), /至少一个 imageId/);
});

/** fetchCtripImageInfoMap 依赖的 evaluate mock：直接调 fn(arg) 取结果，便于纯单测。 */
function buildStaticBrowser(payload: unknown): { browser: PoiSuggestBrowser; calls: unknown[] } {
  const calls: unknown[] = [];
  const browser: PoiSuggestBrowser = {
    evaluate: async <T, A>(fn: (arg: A) => T | Promise<T>, arg: A): Promise<T> => {
      calls.push(arg);
      // evaluate 内部会读 document.cookie / 发 fetch；mock 一个最小 fakeResponse。
      const fakeResponse = { status: 200, text: JSON.stringify(payload) };
      void fakeResponse;
      // 由于 evaluate 函数内部还会 fetch 真实接口，这里模拟它在 BrowserView
      // 之外被直接调用：实际上 fetchCtripImageInfo 的实现固定走真实 fetch，
      // 因此本测只验证 fetchCtripImageInfoMap 的“去重+过滤+空集合快速返回”逻辑，
      // 不走真实 fetch。
      return await fn(arg);
    },
  };
  return { browser, calls };
}

test("fetchCtripImageInfoMap 空集合 → 返回空 Map 且不发起 evaluate", async () => {
  const { browser, calls } = buildStaticBrowser({});
  const map = await fetchCtripImageInfoMap(browser, []);
  assert.equal(map.size, 0);
  assert.deepEqual(calls, [], "空 imageIds 不应触发任何 evaluate");
});

test("fetchCtripImageInfoMap 过滤非法 imageIds（0 / 负数 / 非整数 / 重复）", async () => {
  // 即使过滤后为空，仍然不发起 evaluate，直接返回空 Map。
  const { browser, calls } = buildStaticBrowser({});
  const map = await fetchCtripImageInfoMap(browser, [0, -1, 1.5, Number.NaN, 0, -2] as number[]);
  assert.equal(map.size, 0);
  assert.deepEqual(calls, [], "过滤后空集合不应触发 evaluate");
});
test("buildCtripImageInfoRequest 请求体与 VBK SOA 约定一致（contentType/head/urlOptions/returnTagTypes）", () => {
  const request = buildCtripImageInfoRequest({ cid: "GUID-VALUE", imageIds: [12345] });
  assert.equal(request.contentType, "json");
  assert.deepEqual(request.head, {
    cid: "GUID-VALUE", ctok: "", cver: "1.0", lang: "01",
    sid: "8888", syscode: "09", auth: "", xsid: "", extension: [],
  });
  assert.deepEqual(request.returnTagTypes, ["Attraction", "Country", "District", "PoiId"]);
  assert.deepEqual(request.urlOptions, [
    { width: 200, height: 200, quality: 0.9, type: "R" },
    { width: 500, height: 500, quality: 0.9, type: "R" },
  ]);
  // 不允许在源码里硬编码任何用户身份：cid 由调用方 / 浏览器 cookie 提供。
  assert.equal(buildCtripImageInfoRequest({ cid: "", imageIds: [1] }).head.cid, "");
});

/**
 * ctrip-image-info logger 的可观测事件：fetch-start / fetch-end / fetch-failure。
 * BrowserView evaluate 真实路径会发实际 fetch；这里直接 stub evaluate 返回
 * 「看起来已经完成 evaluate」的结构化摘要，让 main 进程拿到与生产一致的
 * { status, ack, items, durationMs, errorMessage } 流。
 */
function captureImageInfoLogger() {
  const events: CtripImageInfoLogEvent[] = [];
  const logger = (record: CtripImageInfoLogEvent) => {
    events.push(record);
  };
  return { events, logger };
}

/**
 * 拍一个能“只走 main 进程逻辑”的 PoiSuggestBrowser：
 *  - evaluate 不调 fn，只返回传入的 summary；
 *  - 不发真 fetch / 不读真 cookie，从源头把 cookie / header / token / raw body
 *    干涊掉，避免测试期间误发网络请求。
 */
function buildSummaryBrowser(summary: {
  status: number;
  ack: string;
  items: unknown[];
  durationMs: number;
  errorMessage: string | null;
}): { browser: PoiSuggestBrowser; calls: unknown[] } {
  const calls: unknown[] = [];
  const browser: PoiSuggestBrowser = {
    evaluate: async <T>(_fn: (arg: T) => unknown, _arg: T): Promise<unknown> => {
      calls.push(summary);
      if (summary.errorMessage) throw new Error(`携程图库图片查询返回无效 JSON`);
      return {
        status: summary.status,
        payload: { ResponseStatus: { Ack: summary.ack }, body: summary.items },
        durationMs: summary.durationMs,
        ctx: { hasCid: true, cookieNameCount: 1, hasGuidCookie: true, hasVbkLoginCidCookie: false },
      };
    },
  };
  return { browser, calls };
}

/**
 * fetchCtripImageInfo 在成功路径应发出 fetch-start + fetch-end，且 payload
 * 不带 imageIds / body / cookie / token / header；任何 phone-token /
 * raw body 字符串都不应出现在输出里。
 */
test("fetchCtripImageInfo logger：成功路径发出 fetch-start + fetch-end，且不含敏感字段", async () => {
  const { browser, calls } = buildSummaryBrowser({
    status: 200,
    ack: "Success",
    items: [
      {
        imageId: 12345,
        poiName: "云冈石窟",
        originalPath: "https://images.c-ctrip.com/orig/12345.jpg",
      },
    ],
    durationMs: 87,
    errorMessage: null,
  });
  const { events, logger } = captureImageInfoLogger();
  const response = await fetchCtripImageInfo(browser, [12345], { logger });
  assert.equal(calls.length, 1, "evaluate 应被调用一次");
  assert.equal(response.httpStatus, 200);
  assert.equal(response.businessStatus, "Success");
  assert.equal(response.items.length, 1);
  assert.deepEqual(
    events.map((event) => event.event),
    ["fetch-start", "fetch-end"],
  );
  const start = events[0];
  assert.ok(start.event === "fetch-start");
  assert.equal(start.endpoint, GET_IMAGE_INFO_ENDPOINT);
  assert.equal(start.timeoutMs > 0, true, "start 应携带 timeoutMs");
  assert.equal(start.imageIdCount, 1);
  const end = events[1];
  assert.ok(end.event === "fetch-end");
  assert.equal(end.endpoint, GET_IMAGE_INFO_ENDPOINT);
  assert.equal(end.httpStatus, 200);
  assert.equal(end.ack, "Success");
  assert.equal(end.itemCount, 1);
  assert.equal(end.imageIdCount, 1);
  assert.equal(end.durationMs, 87);
  // 敏感内容：cookie 值 / token / header / 原始 imageUrl 列表都不应在日志里出现。
  const joined = JSON.stringify(events);
  for (const keyword of ["GUID-VALUE", "token", "Token", "header", "Header", "originalPath", "imageList", "imageUrls"]) {
    assert.ok(
      !joined.toLowerCase().includes(keyword.toLowerCase()),
      `logger payload 不应携带 ${keyword}：实际 ${joined}`,
    );
  }
  // 同时检 assert 最重要的可观测字段。
  assert.match(joined, /"httpStatus":200/);
  assert.match(joined, /"ack":"Success"/);
});

/**
 * fetchCtripImageInfo 在 HTTP 4xx/5xx 时应发出 fetch-start + fetch-failure，
 * message 携带 HTTP 状态码；不出现 body / cookie。
 */
test("fetchCtripImageInfo logger：HTTP 4xx 时发出 fetch-start + fetch-failure", async () => {
  const { browser } = buildSummaryBrowser({
    status: 503,
    ack: "Unknown",
    items: [],
    durationMs: 33,
    errorMessage: null,
  });
  const { events, logger } = captureImageInfoLogger();
  await assert.rejects(() => fetchCtripImageInfo(browser, [1], { logger }), /HTTP 503/);
  assert.equal(events.length, 2);
  assert.equal(events[0].event, "fetch-start");
  assert.equal(events[1].event, "fetch-failure");
  assert.match(events[1].message, /HTTP 503/);
  assert.equal(events[1].durationMs, 0);
  const joined = JSON.stringify(events);
  for (const keyword of ["GUID-VALUE", "token", "Token", "header", "Header"]) {
    assert.ok(!joined.toLowerCase().includes(keyword.toLowerCase()));
  }
});

/** Ack 非 Success 时仍走 fetch-failure，message 携带原始 Ack 字符串。 */
test("fetchCtripImageInfo logger：Ack 非 Success 走 fetch-failure 携带原始 Ack", async () => {
  const { browser } = buildSummaryBrowser({
    status: 200,
    ack: "Failure",
    items: [],
    durationMs: 12,
    errorMessage: null,
  });
  const { events, logger } = captureImageInfoLogger();
  await assert.rejects(() => fetchCtripImageInfo(browser, [7], { logger }), /业务失败/);
  assert.equal(events.length, 2);
  assert.equal(events[0].event, "fetch-start");
  assert.equal(events[1].event, "fetch-failure");
  assert.match(events[1].message, /业务失败/);
});

/** JSON 解析报错 → fetch-failure 携带错误描述；errorMessage 不会泄漏原始 cookie / header。 */
test("fetchCtripImageInfo logger：JSON 解析报错走 fetch-failure 带错误描述", async () => {
  const { browser } = buildSummaryBrowser({
    status: 200,
    ack: "Unknown",
    items: [],
    durationMs: 5,
    // 使用不含 cookie / token / header 关键字的纯 JSON 解析错误信息。
    errorMessage: "Unexpected end of JSON input",
  });
  const { events, logger } = captureImageInfoLogger();
  await assert.rejects(() => fetchCtripImageInfo(browser, [9], { logger }), /无效 JSON/);
  assert.equal(events.length, 2);
  assert.equal(events[1].event, "fetch-failure");
  assert.match(events[1].message, /无效 JSON/);
  // 送进 fetch-failure 的 errorMessage 不会泄漏原始 cookie 值 / header / token。
  const joined = JSON.stringify(events);
  for (const keyword of ["GUID-VALUE", "token", "Token", "header", "Header"]) {
    assert.ok(!joined.toLowerCase().includes(keyword.toLowerCase()));
  }
});

/**
 * createConsoleCtripImageInfoLogger 的实际 console.warn 输出不含 cookie / token /
 * raw response body；它是主进程 grep 时的唯一面，不应在这里注入任何敏感字段。
 */
test("createConsoleCtripImageInfoLogger 的 console.warn 行不含 cookie / token / raw body", async () => {
  const lines: string[] = [];
  const sink = (line: string) => lines.push(line);
  const consoleLogger = (
    await import("../../src/main/infrastructure/cover-place-search-logger.js")
  ).createConsoleCtripImageInfoLogger({ sink });
  consoleLogger({
    event: "fetch-start",
    endpoint: GET_IMAGE_INFO_ENDPOINT,
    timeoutMs: 12_000,
    imageIdCount: 2,
    ctx: { hasCid: true, cookieNameCount: 2, hasGuidCookie: true, hasVbkLoginCidCookie: false },
  });
  consoleLogger({
    event: "fetch-end",
    endpoint: GET_IMAGE_INFO_ENDPOINT,
    httpStatus: 200,
    ack: "Success",
    itemCount: 1,
    imageIdCount: 2,
    durationMs: 123,
    ctx: { hasCid: true, cookieNameCount: 2, hasGuidCookie: true, hasVbkLoginCidCookie: false },
  });
  consoleLogger({
    event: "fetch-failure",
    endpoint: GET_IMAGE_INFO_ENDPOINT,
    message: "HTTP 503",
    durationMs: 33,
    httpStatus: 503,
    ctx: { hasCid: true, cookieNameCount: 2, hasGuidCookie: true, hasVbkLoginCidCookie: false },
  });
  const joined = lines.join("\n");
  for (const keyword of ["GUID-VALUE", "token", "Token", "header", "Header", "originalPath", "imageList", "imageUrls"]) {
    assert.ok(
      !joined.toLowerCase().includes(keyword.toLowerCase()),
      `ctrip image info 日志不应出现 ${keyword}：实际 ${joined}`,
    );
  }
  assert.match(joined, /ack=Success/);
  assert.match(joined, /HTTP 503/);
  assert.match(joined, new RegExp(`endpoint=${GET_IMAGE_INFO_ENDPOINT.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}`));
});
