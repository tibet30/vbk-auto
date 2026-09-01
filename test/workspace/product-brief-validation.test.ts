import assert from "node:assert/strict";
import test from "node:test";
import { validateProductBrief } from "../../src/renderer/app/helpers/product-brief-validation.js";

test("创建表单把格式错误归属到对应字段", () => {
  assert.deepEqual(validateProductBrief({
    destination: "  ",
    days: 0,
    productForm: "privateTour",
    userIdea: "x".repeat(1001),
  }), {
    destination: "请填写目的地。",
    days: "请填写 2 至 60 天的整数。",
    userIdea: "你的想法不能超过 1000 个字。",
  });
});

test("符合规范的创建表单不显示字段错误", () => {
  assert.deepEqual(validateProductBrief({
    destination: "太原",
    days: 2,
    productForm: "privateTour",
    userIdea: "适合亲子出行",
  }), {});
});
