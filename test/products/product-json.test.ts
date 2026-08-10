import test from "node:test";
import assert from "node:assert/strict";
import { parseProductJson } from "../../src/main/data/product-json.js";
import { parseAndNormalizeProductJson } from "../../src/main/infrastructure/database/product-json-normalize.js";

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

test("数据库读取归一化会把历史字符串 POI ID 转成数字，非法值转 null", () => {
  const product = parseAndNormalizeProductJson(JSON.stringify({
    itinerary: [{
      day: 1,
      spots: [
        { name: "晋祠", poiName: "晋祠博物馆", poiId: "79413" },
        { name: "无效景点", poiName: "无效景点", poiId: "bad" },
      ],
    }],
  })) as Record<string, any>;

  assert.deepEqual(product.itinerary[0].spots, [
    { name: "晋祠", poiName: "晋祠博物馆", poiId: 79413 },
    { name: "无效景点", poiName: "无效景点", poiId: null },
  ]);
});
