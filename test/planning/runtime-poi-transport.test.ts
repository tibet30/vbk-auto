import test from "node:test";
import assert from "node:assert/strict";
import { DbOrchestratorRuntime } from "../../src/main/planning/runtime.js";
import type { VbkBrowser } from "../../src/main/infrastructure/vbk-browser.js";
import type { VbkDatabase } from "../../src/main/infrastructure/database/database.js";

test("规划 POI 查询通过 VbkBrowser.page 的 CDP 页面执行", async () => {
  let pageCalls = 0;
  let pageEvaluateCalls = 0;
  let browserEvaluateCalls = 0;
  const page = {
    async evaluate<T, A>(_fn: (arg: A) => T | Promise<T>, _arg: A): Promise<T> {
      pageEvaluateCalls += 1;
      return {
        status: 200,
        text: JSON.stringify({
          ResponseStatus: { Ack: "Success" },
          poiList: [{ poiName: "晋祠", poiId: 79413 }],
        }),
      } as T;
    },
  };
  const browser = {
    async page() {
      pageCalls += 1;
      return page;
    },
    async evaluate<T>(): Promise<T> {
      browserEvaluateCalls += 1;
      throw new Error("规划 POI 查询不应走 BrowserView.executeJavaScript");
    },
  } as unknown as VbkBrowser;
  const runtime = new DbOrchestratorRuntime({} as VbkDatabase, browser);

  assert.deepEqual(await runtime.suggestPoi("晋祠"), { poiName: "晋祠", poiId: 79413 });
  assert.equal(pageCalls, 1);
  assert.equal(pageEvaluateCalls, 1);
  assert.equal(browserEvaluateCalls, 0);
});

test("未挂载 VBK 浏览器时规划 POI 查询安全跳过", async () => {
  const runtime = new DbOrchestratorRuntime({} as VbkDatabase);

  assert.equal(await runtime.suggestPoi("晋祠"), null);
});
