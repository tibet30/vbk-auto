import test from "node:test";
import assert from "node:assert/strict";

import { assertTrafficLineAck, getTrafficLineEditorState, parseInitialState } from "../../src/main/automation/ctrip/traffic-line/client.ts";
import { buildSaveProductClausesRequest, desiredFirstTabClauses, mergeTrafficLineClauseItems, selectedClauseItems } from "../../src/main/automation/ctrip/traffic-line/clauses.ts";
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
