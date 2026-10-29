import test from "node:test";
import assert from "node:assert/strict";
import {
  ATTRACTION_IMAGE_TYPE_ID,
  BIND_PRODUCT_IMAGE_ENDPOINT,
  COVER_IMAGE_TYPE_ID,
  SEARCH_PRODUCT_IMAGE_ENDPOINT,
  bindCtripLibraryCoverViaApi,
  buildCoverBindRequest,
} from "../../src/main/automation/ctrip/presentation/cover-bind.js";

const UNBIND_ENDPOINT = "https://online.ctrip.com/restapi/soa2/20698/unbindProductImage.json";
const PRODUCT_ID = 76983997;
const OPTIONS = { confirmationAttempts: 1, confirmationIntervalMs: 0 };
const OK = { status: 200, payload: { success: true, ResponseStatus: { Ack: "Success" } } };

const ctx = {
  hasCid: true, cookieNameCount: 1, hasGuidCookie: true, hasVbkLoginCidCookie: false,
  hasUbtVidCookie: false, hasVbkTicketCookie: true, hasBticketCookie: false,
  hasJsSessionIdCookie: true, hasBusinessIdCookie: false, hasBfaCookie: false,
  responseAck: "Success", responseDataItemCount: 1,
};

function browserWithResponses(responses: Array<{ status: number; payload: unknown }>) {
  const calls: Array<{ endpoint: string; body: any }> = [];
  return {
    calls,
    url: () => `https://vbooking.ctrip.com/product/input/productImageText?productId=${PRODUCT_ID}`,
    async evaluate(_fn: unknown, args: { endpoint: string; body: unknown }) {
      calls.push({ endpoint: args.endpoint, body: args.body });
      const next = responses.shift();
      if (!next) throw new Error("unexpected request");
      return { ...next, durationMs: 1, ctx };
    },
  };
}

const search = (...images: unknown[]) => ({
  status: 200, payload: { ResponseStatus: { Ack: "Success" }, productImages: images },
});
const image = (imageId: number, imageTypeId: number) => ({
  sortNum: 0, source: 0, imageInfo: { imageId, accompanyTourInfo: { imageTypeId } },
});
const attractions = (count: number, firstId = 1) =>
  Array.from({ length: count }, (_, index) => image(firstId + index, ATTRACTION_IMAGE_TYPE_ID));
const endpoints = (browser: { calls: Array<{ endpoint: string }> }) => browser.calls.map((call) => call.endpoint);

test("换封面时删除旧封面而不是改成景点图，再绑定新封面并回读", async () => {
  const browser = browserWithResponses([
    search(image(111, COVER_IMAGE_TYPE_ID), ...attractions(19, 1000)),
    OK,
    search(...attractions(19, 1000)),
    OK,
    search(image(222, COVER_IMAGE_TYPE_ID), ...attractions(19, 1000)),
  ]);
  await bindCtripLibraryCoverViaApi(browser as never, 222, OPTIONS);
  assert.deepEqual(endpoints(browser), [
    SEARCH_PRODUCT_IMAGE_ENDPOINT, UNBIND_ENDPOINT, SEARCH_PRODUCT_IMAGE_ENDPOINT,
    BIND_PRODUCT_IMAGE_ENDPOINT, SEARCH_PRODUCT_IMAGE_ENDPOINT,
  ]);
  assert.deepEqual(browser.calls[1].body, { productId: PRODUCT_ID, productImages: [{ imageId: 111, source: 0 }] });
  assert.deepEqual(browser.calls[3].body, buildCoverBindRequest(PRODUCT_ID, 222));
});

test("产品已满 20 张且没有旧封面时，先删最后一张景点图腾出位置", async () => {
  const browser = browserWithResponses([
    search(...attractions(20)),
    OK,
    search(...attractions(19)),
    OK,
    search(image(222, COVER_IMAGE_TYPE_ID), ...attractions(19)),
  ]);
  await bindCtripLibraryCoverViaApi(browser as never, 222, OPTIONS);
  assert.deepEqual(endpoints(browser), [
    SEARCH_PRODUCT_IMAGE_ENDPOINT, UNBIND_ENDPOINT, SEARCH_PRODUCT_IMAGE_ENDPOINT,
    BIND_PRODUCT_IMAGE_ENDPOINT, SEARCH_PRODUCT_IMAGE_ENDPOINT,
  ]);
  assert.deepEqual(browser.calls[1].body, { productId: PRODUCT_ID, productImages: [{ imageId: 20, source: 0 }] });
});

test("已满 20 张但没有可确认类型的景点图时不删除任何图片", async () => {
  const browser = browserWithResponses([
    search(...Array.from({ length: 20 }, (_, index) => image(index + 1, 0))),
  ]);
  await assert.rejects(bindCtripLibraryCoverViaApi(browser as never, 222, OPTIONS), /已满 20 张/);
  assert.deepEqual(endpoints(browser), [SEARCH_PRODUCT_IMAGE_ENDPOINT]);
});

test("删除后回读仍看到该图片则停止，不继续绑定封面", async () => {
  const browser = browserWithResponses([
    search(image(111, COVER_IMAGE_TYPE_ID), ...attractions(5, 1000)),
    OK,
    search(image(111, COVER_IMAGE_TYPE_ID), ...attractions(5, 1000)),
  ]);
  await assert.rejects(bindCtripLibraryCoverViaApi(browser as never, 222, OPTIONS), /回读未确认/);
  assert.equal(endpoints(browser).includes(BIND_PRODUCT_IMAGE_ENDPOINT), false);
});

test("新封面本来就在产品图片里时不占新位置，满 20 张也不删图", async () => {
  const browser = browserWithResponses([
    search(...attractions(20)),
    OK,
    search(image(7, COVER_IMAGE_TYPE_ID), ...attractions(6, 1), ...attractions(13, 8)),
  ]);
  await bindCtripLibraryCoverViaApi(browser as never, 7, OPTIONS);
  assert.deepEqual(endpoints(browser), [
    SEARCH_PRODUCT_IMAGE_ENDPOINT, BIND_PRODUCT_IMAGE_ENDPOINT, SEARCH_PRODUCT_IMAGE_ENDPOINT,
  ]);
});
