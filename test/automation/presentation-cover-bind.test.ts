import test from "node:test";
import assert from "node:assert/strict";
import {
  BIND_PRODUCT_IMAGE_ENDPOINT,
  COVER_IMAGE_TYPE_ID,
  SEARCH_PRODUCT_IMAGE_ENDPOINT,
  bindCtripLibraryCoverViaApi,
  buildCoverBindRequest,
  readProductIdFromVbkUrl,
  responseHasBoundCover,
} from "../../src/main/automation/ctrip/presentation/cover-bind.js";

function browserWithResponses(responses: Array<{ status: number; payload: unknown }>) {
  const calls: Array<{ endpoint: string; body: unknown }> = [];
  return {
    calls,
    url: () => "https://vbooking.ctrip.com/product/input/productImageText?productId=76983997",
    async evaluate(_fn: unknown, args: { endpoint: string; body: unknown }) {
      calls.push({ endpoint: args.endpoint, body: args.body });
      const next = responses.shift();
      if (!next) throw new Error("unexpected request");
      return {
        ...next,
        durationMs: 1,
        ctx: {
          hasCid: true,
          cookieNameCount: 1,
          hasGuidCookie: true,
          hasVbkLoginCidCookie: false,
          hasUbtVidCookie: false,
          hasVbkTicketCookie: true,
          hasBticketCookie: false,
          hasJsSessionIdCookie: true,
          hasBusinessIdCookie: false,
          hasBfaCookie: false,
          responseAck: "Success",
          responseDataItemCount: 1,
        },
      };
    },
  };
}

test("构造最小封面直绑请求", () => {
  assert.deepEqual(buildCoverBindRequest(76983997, 42851842), {
    productId: 76983997,
    productImages: [{
      imageId: 42851842,
      accompanyTourInfo: { imageTypeId: COVER_IMAGE_TYPE_ID, slideShowType: 1 },
    }],
    isCover: true,
  });
  assert.equal(readProductIdFromVbkUrl("https://x.test/path?productid=123"), 123);
  assert.throws(() => readProductIdFromVbkUrl("https://x.test/path"), /正整数/);
});

test("绑定成功后按 imageId 和封面分类回读确认", async () => {
  const browser = browserWithResponses([
    { status: 200, payload: { ResponseStatus: { Ack: "Success" }, productImages: [] } },
    { status: 200, payload: { success: true, ResponseStatus: { Ack: "Success" } } },
    { status: 200, payload: { ResponseStatus: { Ack: "Success" }, productImages: [
      { imageInfo: { imageId: 42851842, accompanyTourInfo: { imageTypeId: 2 } } },
    ] } },
  ]);
  const result = await bindCtripLibraryCoverViaApi(browser as never, 42851842, {
    confirmationAttempts: 1,
    confirmationIntervalMs: 0,
  });
  assert.deepEqual(result, { reused: false, productId: 76983997, imageId: 42851842 });
  assert.equal(browser.calls[0].endpoint, SEARCH_PRODUCT_IMAGE_ENDPOINT);
  assert.equal(browser.calls[1].endpoint, BIND_PRODUCT_IMAGE_ENDPOINT);
  assert.equal(browser.calls[2].endpoint, SEARCH_PRODUCT_IMAGE_ENDPOINT);
  assert.deepEqual(browser.calls[1].body, buildCoverBindRequest(76983997, 42851842));
});

test("目标 imageId 已是封面时只回读，不重复绑定", async () => {
  const browser = browserWithResponses([
    { status: 200, payload: { productImages: [
      { imageInfo: { imageId: 42851842, accompanyTourInfo: { imageTypeId: 2 } } },
    ] } },
  ]);
  const result = await bindCtripLibraryCoverViaApi(browser as never, 42851842);
  assert.deepEqual(result, { reused: true, productId: 76983997, imageId: 42851842 });
  assert.deepEqual(browser.calls.map((call) => call.endpoint), [SEARCH_PRODUCT_IMAGE_ENDPOINT]);
});

test("接口业务失败与回读不一致都不得误报成功", async () => {
  const failed = browserWithResponses([
    { status: 200, payload: { productImages: [] } },
    { status: 200, payload: { success: false, message: "not allowed" } },
  ]);
  await assert.rejects(
    bindCtripLibraryCoverViaApi(failed as never, 1, { confirmationAttempts: 1 }),
    /未返回 success=true：not allowed/,
  );

  const missing = browserWithResponses([
    { status: 200, payload: { productImages: [] } },
    { status: 200, payload: { success: true } },
    { status: 200, payload: { productImages: [
      { imageInfo: { imageId: 999, accompanyTourInfo: { imageTypeId: 2 } } },
      { imageInfo: { imageId: 1, accompanyTourInfo: { imageTypeId: 3 } } },
    ] } },
  ]);
  await assert.rejects(
    bindCtripLibraryCoverViaApi(missing as never, 1, {
      confirmationAttempts: 1,
      confirmationIntervalMs: 0,
    }),
    /回读未确认 imageId=1/,
  );
});

test("回读只接受目标 imageId 的封面分类", () => {
  assert.equal(responseHasBoundCover({ productImages: [
    { imageInfo: { imageId: 7, accompanyTourInfo: { imageTypeId: 2 } } },
  ] }, 7), true);
  assert.equal(responseHasBoundCover({ productImages: [
    { imageInfo: { imageId: 7, accompanyTourInfo: { imageTypeId: 3 } } },
  ] }, 7), false);
});
