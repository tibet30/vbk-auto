// 页面 evaluate 通道的 18 位行程 ID 白名单必须与原生通道
// （vbk-session-fetch-adapter.ts 的 safePayload）保持一致：任何一条通道漏字段，
// 同一个平台响应就会解析出不同的 ID 精度，回写时被平台判为非法参数。

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

test("vbkSessionRequest 对原生通道白名单内的行程 ID 全部保留精确字符串", async () => {
  const ids = {
    tourInfoId: "418082233558728761",
    previewTourInfoId: "418082233558728762",
    auditTourInfoId: "418082233558728763",
    draftTourInfoId: "418082233558728764",
    fromTourInfoId: "418082233558728765",
    tourInfoScoreId: "418082233558728766",
    tourDailyInfoId: "418082233558728767",
  };
  const page = executablePage("GUID=GUID-VALUE", async () => new Response(
    JSON.stringify({ ResponseStatus: { Ack: "Success" }, tourInfos: [ids], ordinary: 409226120750235682 }),
    { status: 200 },
  ));
  const result = await vbkSessionRequest(page, {
    endpoint: "https://online.ctrip.com/restapi/soa2/15638/getProductTourInfoList",
    browserRequestTimeoutMs: 1000,
    evaluateTimeoutMs: 1000,
    errorLabel: "VBK 行程关联查询",
    body: { head: { cid: "" } },
  });
  const tourInfo = (result.payload as any).tourInfos[0];
  for (const [field, value] of Object.entries(ids)) {
    assert.equal(tourInfo[field], value, `${field} 必须保持精确字符串`);
  }
  assert.equal(typeof (result.payload as any).ordinary, "number", "非行程 ID 数值不应被改写成字符串");
});
