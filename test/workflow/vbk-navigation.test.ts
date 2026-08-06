import assert from "node:assert/strict";
import { test } from "node:test";
import { VBK_NAV_SECTIONS } from "../../src/renderer/app/app.main.helpers/app.main.helpers.constants.js";

const host = "https://vbooking.ctrip.com";
const productId = "76522394";

const expectedUrls: Record<string, string> = {
  saleControl: `${host}/ivbk/vendor/saleControlMerge?from=vbk&productId=${productId}`,
  basic: `${host}/ivbk/vendor/baseInfoMerge?productId=${productId}&from=vbk`,
  presentation: `${host}/product/input/productImageText?productId=${productId}&pattern=4&from=vbk`,
  itinerary: `${host}/ivbk/vendor/tourdays?productid=${productId}&istab=1&from=vbk`,
  package: `${host}/ivbk/vendor/packageManage?productid=${productId}&from=vbk`,
  pricingInventory: `${host}/ivbk/vendor/priceInventory?productId=${productId}&from=vbk`,
  resource: `${host}/product/input/newResourceRule?productid=${productId}&from=vbk`,
  terms: `${host}/ivbk/vendor/newResourceClause?productid=${productId}&from=vbk`,
};

test("所有“进入”按钮都映射到 VBK 当前产品菜单的独立页面", () => {
  assert.deepEqual(
    VBK_NAV_SECTIONS.map((section) => section.key),
    ["saleControl", "basic", "presentation", "itinerary", "package", "pricingInventory", "resource", "terms"],
  );

  for (const section of VBK_NAV_SECTIONS) {
    assert.equal(section.buildUrl(productId), expectedUrls[section.key], `${section.label} 路由不正确`);
  }

  assert.equal(new Set(Object.values(expectedUrls)).size, VBK_NAV_SECTIONS.length, "不同入口不能回落到同一个默认页面");
});

test("当前产品销售控制与新增产品销售控制使用不同地址", () => {
  const section = VBK_NAV_SECTIONS.find((candidate) => candidate.key === "saleControl");
  assert.ok(section);
  assert.equal(
    section.buildUrl(undefined),
    `${host}/ivbk/vendor/saleControlMerge?producttype=0&from=vbk`,
  );
  assert.notEqual(section.buildUrl(productId), section.buildUrl(undefined));
});

test("产品 ID 在所有入口地址中都会被编码", () => {
  const unsafeId = "76522394&from=other";
  for (const section of VBK_NAV_SECTIONS) {
    assert.match(section.buildUrl(unsafeId) ?? "", /76522394%26from%3Dother/);
  }
});
