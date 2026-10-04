import test from "node:test";
import assert from "node:assert/strict";
import { SAVE_TOUR_INFO_URL } from "../../src/main/automation/ctrip/itinerary-api/transport.js";
import { saveProductTourInfoStep } from "../../src/main/automation/ctrip/itinerary-api/steps.js";

test("原生行程关联请求保留官方 cookieorigin 登录来源", async () => {
  let writes = 0;
  const page = {
    nativeOnly: true,
    evaluate: async () => { throw new Error("禁止使用页面"); },
    vbkSessionFetch: async (request: any) => {
      writes++;
      assert.equal(request.endpoint, SAVE_TOUR_INFO_URL);
      assert.equal(request.headers.cookieorigin, "https://vbooking.ctrip.com");
      assert.equal(request.headers["x-tt-core"], "1");
      assert.equal(request.headers["x-ctx-locale"], "zh-CN");
      assert.equal(request.headers["x-input-locale"], "zh-CN");
      assert.equal(Object.keys(request.headers).filter(key => key.toLowerCase() === "x-ctx-locale").length, 1);
      assert.equal(request.referrer, "https://vbooking.ctrip.com/ivbk/vendor/tourdays?productid=42&from=vbk");
      assert.equal(request.referrerPolicy, "no-referrer-when-downgrade");
      assert.equal(request.body.saveType, 2);
      return { status: 200, payload: { ResponseStatus: { Ack: "Success" } }, durationMs: 1, ctx: {} as any };
    },
  };
  await saveProductTourInfoStep(page as any, { productId: 42 }, "{}", "draft-v2");
  assert.equal(writes, 1);
});
