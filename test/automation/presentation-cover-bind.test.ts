import test from "node:test";
import assert from "node:assert/strict";
import {
  ATTRACTION_IMAGE_TYPE_ID,
  BIND_PRODUCT_IMAGE_ENDPOINT,
  COVER_IMAGE_TYPE_ID,
  SEARCH_PRODUCT_IMAGE_ENDPOINT,
  bindCtripLibraryCoverViaApi,
  buildCoverBindRequest,
  buildImageTypeBindRequest,
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

test("更换封面只归类明确的旧封面，并回读旧图与新封面最终类型", async () => {
  const browser = browserWithResponses([
    { status: 200, payload: { ResponseStatus: { Ack: "Success" }, productImages: [
      { imageInfo: { imageId: 111, accompanyTourInfo: { imageTypeId: 2 } } },
    ] } },
    { status: 200, payload: { success: true, ResponseStatus: { Ack: "Success" } } },
    { status: 200, payload: { ResponseStatus: { Ack: "Success" }, productImages: [
      { imageInfo: { imageId: 111, accompanyTourInfo: { imageTypeId: ATTRACTION_IMAGE_TYPE_ID } } },
    ] } },
    { status: 200, payload: { success: true, ResponseStatus: { Ack: "Success" } } },
    { status: 200, payload: { ResponseStatus: { Ack: "Success" }, productImages: [
      { imageInfo: { imageId: 111, accompanyTourInfo: { imageTypeId: ATTRACTION_IMAGE_TYPE_ID } } },
      { imageInfo: { imageId: 222, accompanyTourInfo: { imageTypeId: COVER_IMAGE_TYPE_ID } } },
    ] } },
  ]);
  await bindCtripLibraryCoverViaApi(browser as never, 222, {
    confirmationAttempts: 1,
    confirmationIntervalMs: 0,
  });
  assert.deepEqual(browser.calls[1].body, buildImageTypeBindRequest(76983997, 111, ATTRACTION_IMAGE_TYPE_ID));
  assert.equal(browser.calls[2].endpoint, SEARCH_PRODUCT_IMAGE_ENDPOINT);
  assert.deepEqual(browser.calls[3].body, buildCoverBindRequest(76983997, 222));
  assert.equal(browser.calls[4].endpoint, SEARCH_PRODUCT_IMAGE_ENDPOINT);
});

test("无类型图片无法确认业务类型时不被重分类", async () => {
  const browser = browserWithResponses([
    { status: 200, payload: { ResponseStatus: { Ack: "Success" }, productImages: [
      { imageInfo: { imageId: 111, accompanyTourInfo: { imageTypeId: 0 } } },
      { imageInfo: { imageId: 222, accompanyTourInfo: { imageTypeId: 3 } } },
    ] } },
    { status: 200, payload: { success: true, ResponseStatus: { Ack: "Success" } } },
    { status: 200, payload: { ResponseStatus: { Ack: "Success" }, productImages: [
      { imageInfo: { imageId: 111, accompanyTourInfo: { imageTypeId: 0 } } },
      { imageInfo: { imageId: 222, accompanyTourInfo: { imageTypeId: COVER_IMAGE_TYPE_ID } } },
    ] } },
  ]);
  await bindCtripLibraryCoverViaApi(browser as never, 222, {
    confirmationAttempts: 1,
    confirmationIntervalMs: 0,
  });
  assert.deepEqual(browser.calls.map((call) => call.endpoint), [
    SEARCH_PRODUCT_IMAGE_ENDPOINT,
    BIND_PRODUCT_IMAGE_ENDPOINT,
    SEARCH_PRODUCT_IMAGE_ENDPOINT,
  ]);
  assert.deepEqual(browser.calls[1].body, buildCoverBindRequest(76983997, 222));
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

test("封面直绑：显式产品 ID 不读取页面 URL", async () => {
  const browser = browserWithResponses([
    { status: 200, payload: { ResponseStatus: { Ack: "Success" }, productImages: [] } },
    { status: 200, payload: { success: true, ResponseStatus: { Ack: "Success" } } },
    { status: 200, payload: { ResponseStatus: { Ack: "Success" }, productImages: [
      { imageInfo: { imageId: 42851842, accompanyTourInfo: { imageTypeId: 2 } } },
    ] } },
  ]);
  browser.url = () => { throw new Error("production path must not read page.url"); };
  const result = await bindCtripLibraryCoverViaApi(browser as never, 42851842, 77098085, {
    confirmationAttempts: 1,
    confirmationIntervalMs: 0,
  });
  assert.deepEqual(result, { reused: false, productId: 77098085, imageId: 42851842 });
  assert.deepEqual(browser.calls[1].body, buildCoverBindRequest(77098085, 42851842));
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
