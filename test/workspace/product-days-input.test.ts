import assert from "node:assert/strict";
import test from "node:test";
import {
  isValidCreateProductDays,
  parseProductDaysInput,
  productDaysInputValue,
} from "../../src/renderer/app/helpers/product-days-input.js";

test("天数输入可清空后重新填写", () => {
  const cleared = parseProductDaysInput("");
  assert.equal(cleared, 0);
  assert.equal(productDaysInputValue(cleared), "");

  const reentered = parseProductDaysInput("3");
  assert.equal(reentered, 3);
  assert.equal(productDaysInputValue(reentered), 3);
  assert.equal(isValidCreateProductDays(reentered), true);
});

test("创建时仍拒绝空值和超出范围的天数", () => {
  assert.equal(isValidCreateProductDays(0), false);
  assert.equal(isValidCreateProductDays(1), false);
  assert.equal(isValidCreateProductDays(61), false);
});
