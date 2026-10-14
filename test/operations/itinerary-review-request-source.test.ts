import assert from "node:assert/strict";
import test from "node:test";
import { itineraryReviewRequestSource } from "../../src/main/operations/itinerary-review-request-source.js";
import { createVbkRequestPage } from "../../src/main/infrastructure/vbk-request-page.js";

const productId = "79713744";
const source = "https://vbooking.ctrip.com/ivbk/vendor/tourdays?productid=79713744&from=vbk";

test("行程审核请求来源绑定十分类行程页，不导航 BrowserView", async () => {
  const sent: RequestInit[] = [];
  const page = createVbkRequestPage({
    session: {
      cookies: { get: async () => [] },
      fetch: async (_url: string, options: RequestInit) => {
        sent.push(options);
        return { status: 200, text: async () => '{"ResponseStatus":{"Ack":"Success"}}' };
      },
    } as any,
    assertActive: () => undefined,
    currentUrl: () => "https://vbooking.ctrip.com/product/input/productListMerge?from=vbk",
    interactivePage: async () => { throw new Error("请求来源绑定不得打开 BrowserView"); },
  });
  const scoped = itineraryReviewRequestSource(page, productId);
  await scoped.vbkSessionFetch!({
    endpoint: "https://online.ctrip.com/restapi/soa2/15638/checkTourDaily", body: { productId: Number(productId) },
    errorLabel: "写入前核验", headers: {}, includeCidQuery: false, requireReadableCid: false,
  });
  await scoped.vbkSessionGetText!({
    endpoint: "https://vbooking.ctrip.com/ivbk/vendor/tourdays?productid=79713744&from=vbk", errorLabel: "页面证明",
  });
  assert.equal(sent.length, 2);
  for (const request of sent) {
    assert.equal((request.headers as Record<string, string>).referer, source);
    assert.equal(request.referrerPolicy, "no-referrer-when-downgrade");
  }
});

test("无原生来源上下文时保留独立测试客户端", () => {
  const page = { evaluate: async () => undefined };
  assert.equal(itineraryReviewRequestSource(page, productId), page);
});
