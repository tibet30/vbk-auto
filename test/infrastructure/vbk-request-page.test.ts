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
