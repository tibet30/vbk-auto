import test from "node:test";
import assert from "node:assert/strict";
import { parseProductJson } from "../src/main/product-json.js";

test("产品 JSON 接受完整对象并保留嵌套数据", () => {
  const product = parseProductJson('{"basicInfo":{"days":2},"itinerary":[]}');
  assert.deepEqual(product, { basicInfo: { days: 2 }, itinerary: [] });
});

test("产品 JSON 拒绝语法错误", () => {
  assert.throws(() => parseProductJson('{"basicInfo":}'), /JSON 格式错误/);
});

test("产品 JSON 最外层必须是对象", () => {
  assert.throws(() => parseProductJson('[{"day":1}]'), /最外层必须是一个对象/);
  assert.throws(() => parseProductJson('null'), /最外层必须是一个对象/);
});
