import assert from "node:assert/strict";
import test from "node:test";
import { loadSaleControlCreateState } from "../../src/main/automation/ctrip/sale-control/api.js";

test("销售控制前置状态优先走同登录分区请求，不依赖可被导航销毁的页面上下文", async () => {
  let nativeCalls = 0;
  const page = {
    async evaluate() {
      throw new Error("不应调用 page.evaluate");
    },
    async vbkSessionGetText() {
      nativeCalls += 1;
      return {
        status: 200,
        text: 'window.__INITIAL_STATE__ = {"vendorId":1279416,"contractDtos":[]}',
      };
    },
  };

  const state = await loadSaleControlCreateState(page);

  assert.equal(nativeCalls, 1);
  assert.equal(state.vendorId, 1279416);
});

test("销售控制前置状态保留 HTTP 与结构错误边界", async () => {
  await assert.rejects(
    loadSaleControlCreateState({
      evaluate: async () => ({ status: 503, text: "service unavailable" }),
    }),
    /HTTP 503/,
  );
  await assert.rejects(
    loadSaleControlCreateState({
      evaluate: async () => ({ status: 200, text: "<html></html>" }),
    }),
    /缺少 __INITIAL_STATE__/,
  );
});
