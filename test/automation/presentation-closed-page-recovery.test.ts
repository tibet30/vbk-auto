import test from "node:test";
import assert from "node:assert/strict";
import { EMPTY_VBK_SESSION_CONTEXT, vbkSessionRequest } from "../../src/main/infrastructure/vbk-session-request.js";
import type { VbkSessionNativeRequest } from "../../src/main/infrastructure/vbk-session-request.js";
import { bindCtripLibraryPresentationImages } from "../../src/main/automation/ctrip/presentation/main.js";
import { BIND_PRODUCT_IMAGE_ENDPOINT, SEARCH_PRODUCT_IMAGE_ENDPOINT } from "../../src/main/automation/ctrip/presentation/cover-bind.js";

const options = {
  endpoint: SEARCH_PRODUCT_IMAGE_ENDPOINT, body: { productId: 79231570 },
  browserRequestTimeoutMs: 1000, evaluateTimeoutMs: 1000, errorLabel: "回读景点图",
};
const closedError = "page.evaluate: Target page, context or browser has been closed";

test("景点图绑定途中页面关闭后使用同账号请求，续跑复用远端已绑定图片", async () => {
  const images = new Map([[11644066, 2], [19010767, 4]]);
  const writes: number[] = [];
  const nativeCalls: VbkSessionNativeRequest[] = [];
  let closed = false;
  const exchange = (args: { endpoint: string; body: object }) => {
    const body = args.body as { productId: number; productImages?: { imageId: number; accompanyTourInfo: { imageTypeId: number } }[] };
    assert.equal(body.productId, 79231570);
    let payload: unknown;
    if (args.endpoint === SEARCH_PRODUCT_IMAGE_ENDPOINT) {
      payload = { productImages: [...images].map(([imageId, imageTypeId]) => ({ imageInfo: {
        imageId, accompanyTourInfo: { imageTypeId },
      } })) };
    } else {
      assert.equal(args.endpoint, BIND_PRODUCT_IMAGE_ENDPOINT);
      const image = body.productImages![0];
      writes.push(image.imageId);
      images.set(image.imageId, image.accompanyTourInfo.imageTypeId);
      closed = true; // 已写入后关闭，确认请求必须恢复并回读。
      payload = { success: true };
    }
    return { status: 200, payload, durationMs: 1, ctx: { ...EMPTY_VBK_SESSION_CONTEXT } };
  };
  const page = {
    async evaluate(_fn: unknown, args: { endpoint: string; body: object }) {
      if (closed) throw new Error(closedError);
      return exchange(args);
    },
    async vbkSessionFetch(request: VbkSessionNativeRequest) {
      nativeCalls.push(request);
      return exchange(request);
    },
  };
  const cover = { imageId: 11644066, imageUrl: "https://example.test/cover.jpg", poi: "萨迦寺",
    alternates: [19010767, 19022933, 11638015, 42751362].map(imageId => ({
      imageId, imageUrl: `https://example.test/${imageId}.jpg`, poi: "景点",
    })) };
  const first = await bindCtripLibraryPresentationImages(page, cover, 79231570);
  assert.equal(first.attractionImages.length, 4);
  assert.deepEqual(writes, [19022933, 11638015, 42751362]);
  assert.ok(nativeCalls.length > 0);
  assert.ok(nativeCalls.every(request => request.timeoutMs === 12000
    && request.headers.cookieorigin === "https://vbooking.ctrip.com"
    && request.referrer === "https://vbooking.ctrip.com/"));
  const second = await bindCtripLibraryPresentationImages(page, cover, 79231570);
  assert.ok(second.attractionImages.every(image => image.reused));
  assert.deepEqual(writes, [19022933, 11638015, 42751362]);
});

test("缺少同账号请求适配器时保留页面关闭错误", async () => {
  await assert.rejects(vbkSessionRequest({ async evaluate() { throw new Error(closedError); } }, options),
    /Target page, context or browser has been closed/);
});

test("业务错误和结果未知的超时不会切换请求并重复写入", async () => {
  for (const error of ["写入失败：HTTP 500", "接口返回无效 JSON", "BrowserView 执行超时"]) {
    let nativeCalls = 0;
    await assert.rejects(vbkSessionRequest({
      async evaluate() { throw new Error(error); },
      async vbkSessionFetch() {
        nativeCalls += 1;
        throw new Error("不应重试");
      },
    }, options), e => e instanceof Error && e.message === error);
    assert.equal(nativeCalls, 0);
  }
});
