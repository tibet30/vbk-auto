import test from "node:test";
import assert from "node:assert/strict";
import { normalizeUnsupportedProductTypeBeforeShell } from "../../src/main/automation/automation.main/automation.main.product-type.js";

const legacyLongProduct = () => ({
  sales: {
    productType: "domesticLong",
    productForm: "privateTour",
    splitGroup: false,
  },
  basicInfo: { destination: "成都", days: 7, nights: 6 },
});

test("远端产品尚未创建时把旧版 domesticLong 快照安全归一为 domesticShort", () => {
  const original = legacyLongProduct();
  const result = normalizeUnsupportedProductTypeBeforeShell(original);

  assert.equal(result.changed, true);
  assert.equal((result.product.sales as Record<string, unknown>).productType, "domesticShort");
  assert.equal((original.sales as Record<string, unknown>).productType, "domesticLong");
});

test("已有远端产品时不静默修改产品类型", () => {
  const original = legacyLongProduct();
  const result = normalizeUnsupportedProductTypeBeforeShell(original, "77866144");

  assert.equal(result.changed, false);
  assert.equal(result.product, original);
  assert.equal((result.product.sales as Record<string, unknown>).productType, "domesticLong");
});

test("已经是 domesticShort 的产品保持不变", () => {
  const original = legacyLongProduct();
  original.sales.productType = "domesticShort";
  const result = normalizeUnsupportedProductTypeBeforeShell(original);

  assert.equal(result.changed, false);
  assert.equal(result.product, original);
});
