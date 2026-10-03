import test from "node:test";
import assert from "node:assert/strict";
import { getProductBaseInfoSaveModel } from "../../src/main/automation/ctrip/basic-info/save-model.ts";
import type { VbkSessionRequestBrowser } from "../../src/main/infrastructure/vbk-session-request.ts";

const state = { productBaseInfo: { clause: { id: 12 } }, resourceFields: { hotel: true }, localInfoDtos: [{ id: 3 }] };
const response = { status: 200, text: `window.__INITIAL_STATE__ = ${JSON.stringify(state)}` };

test("editor model survives page navigation by using the existing native account session", async () => {
  let calls = 0;
  const page: VbkSessionRequestBrowser = {
    evaluate: async () => { throw new Error("Execution context was destroyed"); },
    vbkSessionGetText: async (request) => {
      calls++;
      assert.match(request.endpoint, /baseInfoMerge\?productId=79234080&from=vbk$/);
      return response;
    },
  };
  assert.deepEqual(await getProductBaseInfoSaveModel(page, "79234080"), {
    ...state.productBaseInfo, resourceFields: state.resourceFields, localInfoDtos: state.localInfoDtos,
  });
  assert.equal(calls, 1);
});

test("native model errors fail before any platform write", async () => {
  for (const [result, expected] of [
    [{ status: 401, text: "login" }, /HTTP 401/],
    [{ status: 200, text: "login" }, /缺少 __INITIAL_STATE__/],
    [{ status: 200, text: "window.__INITIAL_STATE__ = nope" }, /JSON 无效/],
    [{ status: 200, text: "window.__INITIAL_STATE__ = {}" }, /缺少 productBaseInfo/],
  ] as const) {
    const page: VbkSessionRequestBrowser = {
      evaluate: async () => { throw new Error("must not touch navigating page"); },
      vbkSessionGetText: async () => result,
    };
    await assert.rejects(getProductBaseInfoSaveModel(page, "79234080"), expected);
  }
});

test("non-native callers retain the read-only page transport", async () => {
  const page = { evaluate: async () => response } as unknown as VbkSessionRequestBrowser;
  assert.equal((await getProductBaseInfoSaveModel(page, "1")).clause.id, 12);
});
