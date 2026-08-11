import test from "node:test";
import assert from "node:assert/strict";
import {
  buildPoiSuggestRequest,
  POI_BROWSER_REQUEST_TIMEOUT_MS,
  PoiSuggestTimeoutError,
  flattenPoiTextFields,
  pickBestPoi,
  parsePoiSuggestPayload,
  suggestPoi,
  suggestPoiDetail,
  suggestPoiDemo,
} from "../../src/main/infrastructure/poi-suggest.js";

function fakeBrowser(response: { status: number; text: string }) {
  const calls: unknown[] = [];
  return {
    calls,
    browser: {
      async evaluate<T, A>(fn: (arg: A) => T | Promise<T>, arg: A): Promise<T> {
        calls.push(arg);
        const originalDocument = (globalThis as { document?: unknown }).document;
        const originalFetch = globalThis.fetch;
        Object.defineProperty(globalThis, "document", {
          configurable: true,
          value: { cookie: "GUID=test-cid" },
        });
        globalThis.fetch = (async () => ({
          ok: response.status >= 200 && response.status < 300,
          status: response.status,
          text: async () => response.text,
        })) as typeof fetch;
        try {
          return await fn(arg);
        } finally {
          globalThis.fetch = originalFetch;
          if (originalDocument === undefined) {
            delete (globalThis as { document?: unknown }).document;
          } else {
            Object.defineProperty(globalThis, "document", {
              configurable: true,
              value: originalDocument,
            });
          }
        }
      },
    },
  };
}

test("POI 请求体使用当前 VBK SuggestPoi 契约，且不传递会话凭据", () => {
  assert.deepEqual(buildPoiSuggestRequest(" 晋祠 "), {
    requestHeader: { locale: "zh-CN" },
    poiTypes: [
      { key: 3, name: "SIGHT" },
      { key: 19, name: "EDUCATION" },
      { key: 66, name: "SIGHTPLAY" },
      { key: 99, name: "ACTIVITIES" },
    ],
    count: 100,
    keyword: "晋祠",
    tagIds: [],
    useENameSort: "T",
    districtSortDto: { districtIds: [], poiIds: [93331, 79413, 118386477] },
    contentType: "json",
  });
  assert.doesNotMatch(JSON.stringify(buildPoiSuggestRequest("晋祠")), /cookie|ticket|authorization/i);
});

test("业务成功时匹配候选，浏览器调用只传端点、请求体和超时配置", async () => {
  const fake = fakeBrowser({
    status: 200,
    text: JSON.stringify({ ResponseStatus: { Ack: "Success" }, poiList: [{ poiName: "晋祠", poiId: 79413 }] }),
  });
  assert.deepEqual(await suggestPoi(fake.browser, "晋祠"), { poiName: "晋祠", poiId: 79413 });
  assert.equal(fake.calls.length, 1);
  const call = fake.calls[0] as Record<string, unknown>;
  assert.equal(call.endpoint, "https://online.ctrip.com/restapi/soa2/20049/suggestPoi");
  assert.deepEqual(call.body, buildPoiSuggestRequest("晋祠"));
  assert.equal(call.timeoutMs, POI_BROWSER_REQUEST_TIMEOUT_MS);
  assert.equal(call.includeCidQuery, false);
});

test("BrowserView evaluate 悬挂时主进程在上限后返回可识别超时", async () => {
  const browser = {
    evaluate<T>(): Promise<T> {
      return new Promise<T>(() => undefined);
    },
  };

  await assert.rejects(
    suggestPoi(browser, "晋祠", { evaluateTimeoutMs: 1 }),
    (error: unknown) => error instanceof PoiSuggestTimeoutError && /BrowserView 执行超时/.test(error.message),
  );
});

test("页内 fetch 使用 AbortController 在请求超时后取消", async () => {
  const originalFetch = globalThis.fetch;
  const originalDocument = (globalThis as { document?: unknown }).document;
  let requestInit: RequestInit | undefined;
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { cookie: "GUID=test-cid" },
  });
  globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => new Promise((_resolve, reject) => {
    requestInit = init;
    init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  })) as typeof fetch;
  const browser = {
    evaluate<T, A>(fn: (arg: A) => T | Promise<T>, arg: A): Promise<T> {
      return Promise.resolve(fn(arg));
    },
  };
  try {
    await assert.rejects(
      suggestPoi(browser, "晋祠", { browserRequestTimeoutMs: 1, evaluateTimeoutMs: 50 }),
      /VBK POI 查询浏览器请求超时（1ms）/,
    );
    assert.equal(requestInit?.credentials, "include");
    assert.equal(new Headers(requestInit?.headers).get("content-type"), "application/json;charset=UTF-8");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalDocument === undefined) {
      delete (globalThis as { document?: unknown }).document;
    } else {
      Object.defineProperty(globalThis, "document", {
        configurable: true,
        value: originalDocument,
      });
    }
  }
});

test("业务成功但没有候选时返回 null", async () => {
  const fake = fakeBrowser({ status: 200, text: JSON.stringify({ ResponseStatus: { Ack: "Success" }, poiList: [] }) });
  const result = await suggestPoiDemo(fake.browser, "晋祠");
  assert.equal(result.poiListCount, 0);
  assert.equal(result.best, null);
  assert.equal("candidates" in result, false);
  const detail = await suggestPoiDetail(fake.browser, "晋祠");
  assert.deepEqual(detail.candidates, []);
  assert.equal("rawPayload" in detail, false);
});

test("手动 POI 详情解析全部候选、扁平文字字段，并过滤敏感键", () => {
  const result = parsePoiSuggestPayload("晋祠", {
    ResponseStatus: { Ack: "Success" },
    ticket: "must-not-leak",
    poiList: [
      {
        poiName: "晋祠",
        poiId: 79413,
        cityName: "太原",
        address: "晋源区晋祠镇",
        category: { name: "景区", alias: ["祠庙", "博物馆"] },
        Authorization: "must-not-leak",
      },
      { poiName: "晋祠公园", poiId: null, districtName: "晋源区", tags: ["公园"] },
    ],
  });
  assert.equal(result.poiListCount, 2);
  assert.deepEqual(result.best, { poiName: "晋祠", poiId: 79413 });
  assert.equal(result.candidates.length, 2);
  assert.equal(result.candidates[0].selectable, true);
  assert.equal(result.candidates[1].selectable, false);
  assert.deepEqual(
    result.candidates[0].textFields.map((field) => `${field.path}:${field.value}`),
    [
      "poiName:晋祠",
      "poiId:79413",
      "cityName:太原",
      "address:晋源区晋祠镇",
      "category.name:景区",
      "category.alias[0]:祠庙",
      "category.alias[1]:博物馆",
    ],
  );
  const serialised = JSON.stringify(result);
  assert.doesNotMatch(serialised, /must-not-leak|ticket|Authorization|cookie|apiKey/i);
});

test("POI 文字字段递归收集字符串、数字、布尔并跳过敏感字段", () => {
  assert.deepEqual(flattenPoiTextFields({
    name: "A",
    score: 4,
    open: true,
    nested: [{ area: "B", cookie: "hidden" }],
  }), [
    { path: "name", value: "A" },
    { path: "score", value: "4" },
    { path: "open", value: "true" },
    { path: "nested[0].area", value: "B" },
  ]);
});

test("真实响应中的主景点别名只在唯一且完整覆盖时匹配，避免选择下属景点", () => {
  const best = pickBestPoi("秦始皇兵马俑博物馆", {
    poiList: [
      { poiName: "秦始皇兵马俑博物馆-秦始皇雕像", poiId: 145194748 },
      { poiName: "秦始皇兵马俑一号陪葬坑", poiId: 69722564 },
      { poiName: "秦始皇兵马俑博物馆-院史陈列展览", poiId: 149983187 },
      { poiName: "秦始皇帝陵博物院(兵马俑)", poiId: 75682 },
    ],
  });
  assert.deepEqual(best, { poiName: "秦始皇帝陵博物院(兵马俑)", poiId: 75682 });
});

test("完整输入下属景点时，精确名称仍可匹配", () => {
  assert.deepEqual(pickBestPoi("秦始皇兵马俑博物馆-秦始皇雕像", {
    poiList: [
      { poiName: "秦始皇兵马俑博物馆-秦始皇雕像", poiId: 145194748 },
      { poiName: "秦始皇帝陵博物院(兵马俑)", poiId: 75682 },
    ],
  }), { poiName: "秦始皇兵马俑博物馆-秦始皇雕像", poiId: 145194748 });
});

test("POI 别名匹配在组合景点、低置信或多个同等候选时保持待核查", () => {
  assert.equal(pickBestPoi("大雁塔·大唐芙蓉园", {
    poiList: [{ poiName: "大雁塔景区(大雁塔)", poiId: 1 }],
  }), null);
  assert.equal(pickBestPoi("兵马俑博物馆", {
    poiList: [{ poiName: "西安博物院(兵马俑)", poiId: 2 }],
  }), null);
  assert.equal(pickBestPoi("秦始皇兵马俑博物馆", {
    poiList: [
      { poiName: "秦始皇帝陵博物院(兵马俑)", poiId: 3 },
      { poiName: "秦始皇陵博物院(兵马俑)", poiId: 4 },
    ],
  }), null);
});

test("组合景点关键词在任何候选匹配前保持待核查", () => {
  assert.equal(pickBestPoi("大雁塔·大唐不夜城", {
    poiList: [{ poiName: "大唐不夜城", poiId: 10557626 }],
  }), null);
  assert.equal(pickBestPoi("回民街/永兴坊", {
    poiList: [{ poiName: "回民街", poiId: 10559031 }],
  }), null);
  assert.deepEqual(pickBestPoi("华清宫", {
    poiList: [{ poiName: "华清宫", poiId: 79658 }],
  }), { poiName: "华清宫", poiId: 79658 });
  assert.deepEqual(pickBestPoi("秦始皇兵马俑博物馆", {
    poiList: [{ poiName: "秦始皇帝陵博物院(兵马俑)", poiId: 75682 }],
  }), { poiName: "秦始皇帝陵博物院(兵马俑)", poiId: 75682 });
});

test("精确和双向名称匹配仍优先于别名候选", () => {
  assert.deepEqual(pickBestPoi("晋祠", {
    poiList: [
      { poiName: "晋祠博物馆(晋祠)", poiId: 1 },
      { poiName: "晋祠", poiId: 79413 },
    ],
  }), { poiName: "晋祠", poiId: 79413 });
  assert.deepEqual(pickBestPoi("秦始皇兵马俑", {
    poiList: [{ poiName: "秦始皇兵马俑博物馆", poiId: 75682 }],
  }), { poiName: "秦始皇兵马俑博物馆", poiId: 75682 });
});

test("主景点的部分名称不会因候选列表顺序误选下属景点", () => {
  assert.deepEqual(pickBestPoi("秦始皇兵马俑", {
    poiList: [
      { poiName: "秦始皇兵马俑一号陪葬坑", poiId: 69722564 },
      { poiName: "秦始皇帝陵博物院（兵马俑）", poiId: 75682 },
    ],
  }), { poiName: "秦始皇帝陵博物院（兵马俑）", poiId: 75682 });
});

test("无效 POI ID 不会被当作有效候选", () => {
  assert.equal(pickBestPoi("晋祠", {
    poiList: [{ poiName: "晋祠", poiId: "not-a-number" }],
  }), null);
  assert.equal(pickBestPoi("晋祠", {
    poiList: [{ poiName: "晋祠", poiId: "79413" }],
  }), null);
  assert.equal(pickBestPoi("晋祠", {
    poiList: [{ poiName: "晋祠", poiId: 0 }],
  }), null);
});

test("别名和官方名重叠覆盖时保持待核查，不能把同一段字符计两次", () => {
  assert.equal(pickBestPoi("秦始皇兵马俑博物馆", {
    poiList: [{ poiName: "秦始皇甲兵马俑博物院（秦始皇乙兵马俑）", poiId: 1 }],
  }), null);
});

test("业务 Failure、HTTP 失败和无效 JSON 都向上抛出可见错误", async () => {
  const businessFailure = fakeBrowser({
    status: 200,
    text: JSON.stringify({ ResponseStatus: { Ack: "Failure", Errors: [{ Message: "请求体无效" }] } }),
  });
  await assert.rejects(suggestPoi(businessFailure.browser, "晋祠"), /VBK POI 查询业务失败：请求体无效/);

  const httpFailure = fakeBrowser({ status: 403, text: "{}" });
  await assert.rejects(suggestPoi(httpFailure.browser, "晋祠"), /VBK POI 查询失败：HTTP 403/);

  const invalidJson = fakeBrowser({ status: 200, text: "not-json" });
  await assert.rejects(suggestPoi(invalidJson.browser, "晋祠"), /VBK POI 查询返回无效 JSON/);
});
