import test from "node:test";
import assert from "node:assert/strict";
import { waitForProductIdFromUrl } from "../../src/main/automation/ctrip/sale-control/sale-control.workflow.js";

function pageWithUrls(urls: string[]) {
  let index = 0;
  return {
    url() {
      const value = urls[Math.min(index, urls.length - 1)];
      index += 1;
      return value;
    },
  };
}

test("销售控制页回填 productId 时仍等待产品信息详情页", async () => {
  const page = pageWithUrls([
    "https://vbooking.ctrip.com/ivbk/vendor/saleControlMerge?productId=77428872&from=vbk",
    "https://vbooking.ctrip.com/ivbk/vendor/saleControlMerge?productId=77428872&from=vbk",
    "https://vbooking.ctrip.com/ivbk/vendor/baseInfoMerge?productId=77428872&from=vbk",
  ]);

  const productId = await waitForProductIdFromUrl(page);

  assert.equal(productId, "77428872");
});

test("只有销售控制 URL 时不误判为产品信息已打开", async () => {
  const page = pageWithUrls([
    "https://vbooking.ctrip.com/ivbk/vendor/saleControlMerge?productId=77428872&from=vbk",
  ]);

  const productId = await waitForProductIdFromUrl(page, 250);

  assert.equal(productId, null);
});
