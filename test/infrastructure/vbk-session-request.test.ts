import test from "node:test";
import assert from "node:assert/strict";
import { vbkSessionRequest } from "../../src/main/infrastructure/vbk-session-request.js";

function executablePage(cookie: string, fetchImpl: typeof fetch) {
  return {
    async evaluate<T, A>(fn: (arg: A) => T | Promise<T>, arg: A) {
      const previousDocument = (globalThis as { document?: unknown }).document;
      const previousFetch = globalThis.fetch;
      (globalThis as { document?: { cookie: string } }).document = { cookie };
      globalThis.fetch = fetchImpl;
      try {
        return await fn(arg);
      } finally {
        if (previousDocument === undefined) delete (globalThis as { document?: unknown }).document;
        else (globalThis as { document?: unknown }).document = previousDocument;
        globalThis.fetch = previousFetch;
      }
    },
  };
}

function jsonResponse(payload: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(payload), { status: 200, ...init });
}

test("vbkSessionRequest 在浏览器上下文读取 CID、补 trace/header/body，并带 include 凭据", async () => {
  let captured: { url: string; init: RequestInit } | null = null;
  const page = executablePage("foo=bar; GUID=GUID-VALUE", async (url, init) => {
    captured = { url: String(url), init: init ?? {} };
    return jsonResponse({ ResponseStatus: { Ack: "Success" } });
  });
  const result = await vbkSessionRequest(page, {
    endpoint: "https://online.ctrip.com/restapi/soa2/1/demo",
    browserRequestTimeoutMs: 1000,
    evaluateTimeoutMs: 1000,
    errorLabel: "VBK 测试请求",
    headers: { "x-tour-auth-from": "vbk" },
    body: { contentType: "json", head: { cid: "", lang: "01" }, keyword: "太原" },
  });

  assert.equal(result.status, 200);
  // ctx 实际契约已扩展（含反作弊 cookie 布尔、响应 Ack / 数据条数诊断字段），
  // 这里只断言与本次调用相关的关键子集，避免深比较锁死未来字段；其余字段由新增的
  // 表驱动测试覆盖。
  assert.equal(result.ctx.hasCid, true);
  assert.equal(result.ctx.cookieNameCount, 2);
  assert.equal(result.ctx.hasGuidCookie, true);
  assert.equal(result.ctx.hasVbkLoginCidCookie, false);
  assert.ok(captured);
  assert.match(captured!.url, /_fxpcqlniredt=GUID-VALUE/);
  assert.match(captured!.url, /x-traceID=GUID-VALUE-/);
  assert.equal(captured!.init.credentials, "include");
  assert.equal((captured!.init.headers as Record<string, string>)["x-tour-auth-from"], "vbk");
  assert.equal((captured!.init.headers as Record<string, string>)["x-ctx-locale"], "zh-CN");
  assert.equal(JSON.parse(String(captured!.init.body)).head.cid, "GUID-VALUE");
});

test("vbkSessionRequest 保留图库请求需要的 header/referrer，并支持不追加 cid query", async () => {
  let captured: { url: string; init: RequestInit } | null = null;
  const page = executablePage("vbk_login_cid=CID-VALUE", async (url, init) => {
    captured = { url: String(url), init: init ?? {} };
    return jsonResponse({ ResponseStatus: { Ack: "Success" } });
  });

  await vbkSessionRequest(page, {
    endpoint: "https://online.ctrip.com/restapi/soa2/12719/searchImage",
    browserRequestTimeoutMs: 1000,
    evaluateTimeoutMs: 1000,
    errorLabel: "图库搜索",
    includeCidQuery: false,
    headers: {
      "accept-language": "zh-CN,zh;q=0.9",
      cookieorigin: "https://vbooking.ctrip.com",
      "x-input-locale": "zh-CN",
    },
    referrer: "https://vbooking.ctrip.com/product/input/productImageText?pattern=1&from=vbk",
    referrerPolicy: "strict-origin-when-cross-origin",
    body: { contentType: "json", head: { cid: "", lang: "01" }, imageIds: [1] },
  });

  assert.ok(captured);
  assert.doesNotMatch(captured!.url, /_fxpcqlniredt=/);
  assert.match(captured!.url, /x-traceID=CID-VALUE-/);
  assert.equal(captured!.init.credentials, "include");
  assert.equal(captured!.init.referrer, "https://vbooking.ctrip.com/product/input/productImageText?pattern=1&from=vbk");
  assert.equal(captured!.init.referrerPolicy, "strict-origin-when-cross-origin");
  const headers = captured!.init.headers as Record<string, string>;
  assert.equal(headers["content-type"], "application/json;charset=UTF-8");
  assert.equal(headers["accept-language"], "zh-CN,zh;q=0.9");
  assert.equal(headers.cookieorigin, "https://vbooking.ctrip.com");
  assert.equal(headers["x-input-locale"], "zh-CN");
  assert.equal(JSON.parse(String(captured!.init.body)).head.cid, "CID-VALUE");
});

test("vbkSessionRequest 把超出安全整数的行程 ID 保留为精确字符串", async () => {
  const raw = '{"ResponseStatus":{"Ack":"Success"},"tourInfos":[{"tourInfoId":0,"previewTourInfoId":409226120750235682}],"ordinary":409226120750235682}';
  const page = executablePage("GUID=GUID-VALUE", async () => new Response(raw, { status: 200 }));
  const result = await vbkSessionRequest(page, {
    endpoint: "https://online.ctrip.com/restapi/soa2/15638/getProductTourInfoList",
    browserRequestTimeoutMs: 1000,
    evaluateTimeoutMs: 1000,
    errorLabel: "VBK 行程关联查询",
    body: { head: { cid: "" } },
  });
  const payload = result.payload as any;
  assert.equal(payload.tourInfos[0].tourInfoId, 0);
  assert.equal(payload.tourInfos[0].previewTourInfoId, "409226120750235682");
  assert.equal(typeof payload.ordinary, "number", "非行程 ID 数值不应被改写成字符串");
});

test("vbkSessionRequest 缺 GUID/vbk_login_cid 时抛中文登录态错误", async () => {
  const page = executablePage("foo=bar", async () => jsonResponse({}));
  await assert.rejects(
    vbkSessionRequest(page, {
      endpoint: "https://online.ctrip.com/restapi/soa2/1/demo",
      browserRequestTimeoutMs: 1000,
      evaluateTimeoutMs: 1000,
      errorLabel: "VBK 测试请求",
      body: { head: { cid: "" } },
    }),
    /缺少 cid.*GUID.*vbk_login_cid/,
  );
});

test("vbkSessionRequest HTTP 和 JSON 错误不携带响应原文", async () => {
  const httpPage = executablePage("vbk_login_cid=CID-VALUE", async () => new Response("secret raw body", { status: 500 }));
  await assert.rejects(
    vbkSessionRequest(httpPage, {
      endpoint: "https://online.ctrip.com/restapi/soa2/1/demo",
      browserRequestTimeoutMs: 1000,
      evaluateTimeoutMs: 1000,
      errorLabel: "VBK 测试请求",
      body: { head: { cid: "" } },
    }),
    (error) => error instanceof Error && /HTTP 500/.test(error.message) && !/secret raw body/.test(error.message),
  );

  const jsonPage = executablePage("vbk_login_cid=CID-VALUE", async () => new Response("secret raw body", { status: 200 }));
  await assert.rejects(
    vbkSessionRequest(jsonPage, {
      endpoint: "https://online.ctrip.com/restapi/soa2/1/demo",
      browserRequestTimeoutMs: 1000,
      evaluateTimeoutMs: 1000,
      errorLabel: "VBK 测试请求",
      body: { head: { cid: "" } },
    }),
    (error) => error instanceof Error && /返回无效 JSON/.test(error.message) && !/secret raw body/.test(error.message),
  );
});

test("vbkSessionRequest 浏览器侧超时与 evaluate 超时都有明确错误", async () => {
  const slowFetchPage = executablePage("GUID=GUID-VALUE", async (_url, init) => {
    await new Promise((_resolve, reject) => {
      (init?.signal as AbortSignal).addEventListener("abort", () => reject(new Error("aborted")));
    });
    return jsonResponse({});
  });
  await assert.rejects(
    vbkSessionRequest(slowFetchPage, {
      endpoint: "https://online.ctrip.com/restapi/soa2/1/demo",
      browserRequestTimeoutMs: 5,
      evaluateTimeoutMs: 100,
      errorLabel: "VBK 测试请求",
      body: { head: { cid: "" } },
    }),
    /浏览器请求超时/,
  );

  const hangingPage = { async evaluate() { return new Promise(() => undefined); } };
  await assert.rejects(
    vbkSessionRequest(hangingPage, {
      endpoint: "https://online.ctrip.com/restapi/soa2/1/demo",
      browserRequestTimeoutMs: 100,
      evaluateTimeoutMs: 5,
      errorLabel: "VBK 测试请求",
      body: { head: { cid: "" } },
    }),
    /BrowserView 执行超时/,
  );
});

// ─────────────────────────────────────────────────────────────────────────
// 7. 真实 evaluate 闭包：responseDataItemCount 在 6 种响应形态下的归一化计数，
//    以及 responseAck 的提取。不记录 / 不断言 cookie 值与原始 payload。
// ─────────────────────────────────────────────────────────────────────────

/**
 * 6 种 suggestPoi 响应形态：每种都构造 2 条候选，断言 ctx.responseDataItemCount === 2。
 * 同时验证 ctx.responseAck === "Success"。fetch 由 stub 直接接管，
 * 评估闭包会被真实执行（闭包内部的解析与 ctx 填充逻辑走完整路径）。
 */
const responseShapeCases: Array<{ name: string; build: () => unknown }> = [
  {
    name: "顶层 poiDtos",
    build: () => ({
      ResponseStatus: { Ack: "Success", Errors: [] },
      poiDtos: [
        { poiId: 1, poiName: "A" },
        { poiId: 2, poiName: "B" },
      ],
    }),
  },
  {
    name: "顶层 body",
    build: () => ({
      ResponseStatus: { Ack: "Success", Errors: [] },
      body: [
        { poiId: 3, poiName: "C" },
        { poiId: 4, poiName: "D" },
      ],
    }),
  },
  {
    name: "顶层 poiList",
    build: () => ({
      ResponseStatus: { Ack: "Success", Errors: [] },
      poiList: [
        { poiId: 5, poiName: "E" },
        { poiId: 6, poiName: "F" },
      ],
    }),
  },
  {
    name: "data.poiDtos",
    build: () => ({
      ResponseStatus: { Ack: "Success", Errors: [] },
      data: {
        poiDtos: [
          { poiId: 7, poiName: "G" },
          { poiId: 8, poiName: "H" },
        ],
      },
    }),
  },
  {
    name: "data.poiList",
    build: () => ({
      ResponseStatus: { Ack: "Success", Errors: [] },
      data: {
        poiList: [
          { poiId: 9, poiName: "I" },
          { poiId: 10, poiName: "J" },
        ],
      },
    }),
  },
  {
    name: "data.body",
    build: () => ({
      ResponseStatus: { Ack: "Success", Errors: [] },
      data: {
        body: [
          { poiId: 11, poiName: "K" },
          { poiId: 12, poiName: "L" },
        ],
      },
    }),
  },
];

test("vbkSessionRequest evaluate 闭包：6 种响应形态下 responseDataItemCount 与 responseAck 正确", async () => {
  for (const shape of responseShapeCases) {
    // 让 fetch 返回对应形态的 payload；fetchImpl 本身不读取请求细节（避免断言 cookie / payload）。
    const payload = shape.build();
    const page = executablePage("GUID=GUID-VALUE", async () => jsonResponse(payload));
    const result = await vbkSessionRequest(page, {
      endpoint: "https://online.ctrip.com/restapi/soa2/1/demo",
      browserRequestTimeoutMs: 1000,
      evaluateTimeoutMs: 1000,
      errorLabel: `形态-${shape.name}`,
      body: { head: { cid: "" } },
    });
    assert.equal(result.status, 200, `${shape.name}: status`);
    assert.equal(result.ctx.responseAck, "Success", `${shape.name}: responseAck`);
    assert.equal(result.ctx.responseDataItemCount, 2, `${shape.name}: responseDataItemCount`);
  }
});

test("vbkSessionRequest evaluate 闭包：Failure Ack 被原样截断到 responseAck（≤200）", async () => {
  const failureAck = "Failure: token expired " + "x".repeat(220);
  const page = executablePage("GUID=GUID-VALUE", async () =>
    jsonResponse({
      ResponseStatus: { Ack: failureAck, Errors: [{ Message: "登录态失效" }] },
      body: [],
    }),
  );
  const result = await vbkSessionRequest(page, {
    endpoint: "https://online.ctrip.com/restapi/soa2/1/demo",
    browserRequestTimeoutMs: 1000,
    evaluateTimeoutMs: 1000,
    errorLabel: "Ack 截断验证",
    body: { head: { cid: "" } },
  });
  assert.equal(result.status, 200);
  assert.equal(result.ctx.responseAck.length, 200);
  assert.ok(result.ctx.responseAck.startsWith("Failure: token expired"));
  assert.equal(result.ctx.responseDataItemCount, 0);
});
