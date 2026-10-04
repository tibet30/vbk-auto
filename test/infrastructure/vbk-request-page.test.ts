import assert from "node:assert/strict";
import test from "node:test";
import { createVbkRequestPage, getVbkRequestPage } from "../../src/main/infrastructure/vbk-request-page.js";
import { vbkSessionRequest } from "../../src/main/infrastructure/vbk-session-request.js";

test("接口客户端无需页面，发送当前会话凭据并保留超长行程 ID", async () => {
  let acquired = 0;
  let cookieFilter: unknown;
  let sent: RequestInit | undefined;
  const page = createVbkRequestPage({
    session: {
      cookies: { get: async (filter: unknown) => { cookieFilter = filter; return [{ name: "GUID", value: "current-cid" }]; } },
      fetch: async (_url: string, options: RequestInit) => {
        sent = options;
        return { status: 200, text: async () => '{"ResponseStatus":{"Ack":"Success"},"draftTourInfoId":417899634191761447}' };
      },
    } as any,
    assertActive: () => undefined,
    currentUrl: () => "https://vbooking.ctrip.com/",
    interactivePage: async () => { acquired++; throw new Error("页面不可用"); },
  });
  const result = await vbkSessionRequest(page, {
    endpoint: "https://online.ctrip.com/restapi/soa2/15638/demo", body: { head: { cid: "" } },
    errorLabel: "无页面验收", browserRequestTimeoutMs: 1000, evaluateTimeoutMs: 1000,
  });
  assert.equal(acquired, 0);
  assert.deepEqual(cookieFilter, { url: "https://vbooking.ctrip.com/" });
  assert.equal(sent?.credentials, "include");
  assert.equal(JSON.parse(String(sent?.body)).head.cid, "current-cid");
  assert.equal((result.payload as any).draftTourInfoId, "417899634191761447");
});

test("账号切换后旧客户端不发出请求，也不获取交互页面", async () => {
  let active = true;
  let requests = 0;
  const page = createVbkRequestPage({
    session: { cookies: { get: async () => [] }, fetch: async () => { requests++; } } as any,
    assertActive: () => { if (!active) throw new Error("账号已切换"); },
    currentUrl: () => "https://vbooking.ctrip.com/",
    interactivePage: async () => { requests++; throw new Error("不应打开页面"); },
  });
  active = false;
  await assert.rejects(page.vbkSessionGetText!({ endpoint: "https://vbooking.ctrip.com/", errorLabel: "读取" }), /账号已切换/);
  await assert.rejects(page.acquireInteractivePage(), /账号已切换/);
  assert.equal(requests, 0);
});

test("原生请求超时会中止网络请求", async () => {
  let aborted = false;
  const page = createVbkRequestPage({
    session: {
      cookies: { get: async () => [] },
      fetch: async (_url: string, options: RequestInit) => new Promise((_resolve, reject) => {
        options.signal?.addEventListener("abort", () => { aborted = true; reject(new Error("aborted")); });
      }),
    } as any,
    assertActive: () => undefined, currentUrl: () => "https://vbooking.ctrip.com/",
    interactivePage: async () => { throw new Error("不应打开页面"); },
  });
  await assert.rejects(vbkSessionRequest(page, {
    endpoint: "https://online.ctrip.com/demo", body: {}, errorLabel: "超时", browserRequestTimeoutMs: 10, evaluateTimeoutMs: 500,
  }), /aborted/);
  assert.equal(aborted, true);
});

test("规划和录入入口优先获取请求客户端，兼容独立 Playwright", async () => {
  const client = {} as any;
  assert.equal(await getVbkRequestPage({ requestPage: async () => client, page: async () => { throw new Error("页面不可用"); } }), client);
  assert.equal(await getVbkRequestPage({ page: async () => client }), client);
});

test("空白视图使用 VBK 来源，不依赖打开业务页面", async () => {
  const page = createVbkRequestPage({
    session: {} as any, assertActive: () => undefined,
    currentUrl: () => "about:blank", interactivePage: async () => { throw new Error("不应打开页面"); },
  });
  assert.equal(page.url(), "https://vbooking.ctrip.com/");
});

test("阶段来源不打开页面，并发产品隔离且结束后恢复默认来源", async () => {
  const sent: RequestInit[] = [];
  const page = createVbkRequestPage({
    session: { cookies: { get: async () => [] }, fetch: async (_url: string, options: RequestInit) => {
      sent.push(options); return { status: 200, text: async () => '{"ResponseStatus":{"Ack":"Success"}}' };
    } } as any,
    assertActive: () => {}, currentUrl: () => "about:blank",
    interactivePage: async () => { throw Error("禁止获取页面"); },
  });
  const request = (productId: number) => vbkSessionRequest(page, {
    endpoint: "https://online.ctrip.com/restapi/soa2/15638/getPackageList", body: { productId },
    errorLabel: "套餐", browserRequestTimeoutMs: 1000, evaluateTimeoutMs: 1000,
  });
  await Promise.all([1, 2].map(id => page.withRequestSource(
    `https://vbooking.ctrip.com/ivbk/vendor/packageManage?productid=${id}&from=vbk`,
    async () => { await Promise.resolve(); await request(id); },
  )));
  for (const options of sent) {
    const id = JSON.parse(String(options.body)).productId;
    assert.equal((options.headers as any).referer, `https://vbooking.ctrip.com/ivbk/vendor/packageManage?productid=${id}&from=vbk`);
    assert.equal((options.headers as any)["x-ctx-locale"], "zh-CN");
    assert.equal(Object.keys(options.headers as any).filter(key => key.toLowerCase() === "x-ctx-locale").length, 1);
  }
  await request(3);
  assert.equal((sent[2].headers as any).referer, "https://vbooking.ctrip.com/");
  assert.equal(page.url(), "https://vbooking.ctrip.com/");
  await vbkSessionRequest(page, {
    endpoint: "https://online.ctrip.com/restapi/soa2/15638/suggestDepartureCity", body: {},
    errorLabel: "语言字段", browserRequestTimeoutMs: 1000, evaluateTimeoutMs: 1000,
    headers: { "x-ctx-Locale": "en-US", "x-input-Locale": "en-US" },
  });
  assert.equal((sent[3].headers as any)["x-ctx-locale"], "en-US");
  assert.equal(Object.keys(sent[3].headers as any).filter(key => key.toLowerCase() === "x-ctx-locale").length, 1);
});

test("创建业务上下文只覆盖本次接口请求，保留账号凭据且不写 Cookie", async () => {
  const requests: RequestInit[] = [];
  const original = [{ name: "vbkticket", value: "synthetic-ticket" },
    { name: "vbk-menu-business-id", value: "6" }, { name: "vbk-menu-business-parameter", value: "old-context" }];
  const page = createVbkRequestPage({
    session: { cookies: { get: async () => original, set: async () => { throw Error("不允许写 Cookie"); } },
      fetch: async (_url: string, options: RequestInit) => {
        requests.push(options);
        return { status: 200, text: async () => '{"ResponseStatus":{"Ack":"Success"}}' };
      },
    } as any,
    assertActive: () => {}, currentUrl: () => "https://vbooking.ctrip.com/",
    interactivePage: async () => { throw Error("不允许打开页面"); },
  });
  const options = { endpoint: "https://online.ctrip.com/restapi/soa2/15638/saveSaleControlInfo", body: {},
    errorLabel: "创建", browserRequestTimeoutMs: 1000, evaluateTimeoutMs: 1000 };
  await vbkSessionRequest(page, { ...options, businessContext: { businessId: 1, travelType: 1 } });
  const headers = requests[0].headers as Record<string, string>;
  assert.equal(requests[0].credentials, "omit");
  assert.match(headers.cookie, /vbkticket=synthetic-ticket/);
  assert.match(headers.cookie, /vbk-menu-business-id=1(?:;|$)/);
  assert.doesNotMatch(headers.cookie, /old-context|business-id=6/);
  await vbkSessionRequest(page, options);
  assert.equal((requests[1].headers as Record<string, string>).cookie, undefined);
  assert.equal(requests[1].credentials, "include");
  assert.equal(original[1].value, "6");
  await assert.rejects(vbkSessionRequest(page, { ...options, endpoint: "https://example.com/", businessContext: { businessId: 1, travelType: 1 } }), /仅用于携程产品创建接口/);
  assert.equal(requests.length, 2);
});
