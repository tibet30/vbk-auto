import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { isPinnedVbkNavigationAllowed } from "../../src/main/infrastructure/vbk-navigation-pin.js";

const pin = {
  allowedProductIds: ["1001", "2002"],
  allowCreateSetup: true,
};

test("未钉住时不拦截", () => {
  assert.equal(isPinnedVbkNavigationAllowed("https://vbooking.ctrip.com/product/input/productListMerge?from=vbk", null), true);
});

test("允许创建套装入口和已登记的产品页", () => {
  assert.equal(isPinnedVbkNavigationAllowed(
    "https://vbooking.ctrip.com/ivbk/vendor/saleControlMerge?producttype=0&from=vbk",
    pin,
  ), true);
  assert.equal(isPinnedVbkNavigationAllowed(
    "https://vbooking.ctrip.com/ivbk/vendor/baseInfoMerge?productId=1001&from=vbk",
    pin,
  ), true);
  assert.equal(isPinnedVbkNavigationAllowed(
    "https://vbooking.ctrip.com/ivbk/vendor/trafficLineEdit?productid=2002&istab=1&from=vbk",
    pin,
  ), true);
});

test("拒绝列表页、其它产品和无关图库页", () => {
  assert.equal(isPinnedVbkNavigationAllowed(
    "https://vbooking.ctrip.com/product/input/productListMerge?from=vbk",
    pin,
  ), false);
  assert.equal(isPinnedVbkNavigationAllowed(
    "https://vbooking.ctrip.com/ivbk/vendor/baseInfoMerge?productId=9999&from=vbk",
    pin,
  ), false);
  assert.equal(isPinnedVbkNavigationAllowed(
    "https://vbooking.ctrip.com/product/input/newResourceRule?productid=8888&from=vbk",
    pin,
  ), false);
});

test("VbkBrowser 导航钩子必须咨询产品钉住规则", () => {
  const source = readFileSync(resolve(import.meta.dirname, "../../src/main/infrastructure/vbk-browser.ts"), "utf8");
  assert.match(source, /isPinnedVbkNavigationAllowed\(url, this\.navigationPin\)/);
});
