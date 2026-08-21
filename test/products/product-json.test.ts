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

test("数据库读取会修复行政地点尾缀，并以历史 meetingCity 统一两城市", () => {
  const product = parseAndNormalizeProductJson(JSON.stringify({
    basicInfo: {
      meetingCity: "成都",
      destinationCity: "西安市",
      province: "四川省",
    },
    operations: { pickupCity: "成都市" },
  })) as Record<string, any>;

  assert.equal(product.basicInfo.meetingCity, "成都");
  assert.equal(product.basicInfo.destinationCity, "成都");
  assert.equal(product.basicInfo.province, "四川");
  assert.equal(product.operations.pickupCity, "成都");
});

test("数据库读取保留景区名称，不把景区后缀当行政区裁掉", () => {
  const product = parseAndNormalizeProductJson(JSON.stringify({
    basicInfo: { meetingCity: "宽窄巷子景区", destinationCity: "宽窄巷子景区", province: "四川省" },
    itinerary: [{ spots: [{ name: "宽窄巷子景区" }] }],
  })) as Record<string, any>;

  assert.equal(product.basicInfo.meetingCity, "宽窄巷子景区");
  assert.equal(product.basicInfo.destinationCity, "宽窄巷子景区");
  assert.equal(product.itinerary[0].spots[0].name, "宽窄巷子景区");
});

test("数据库读取归一化会解开误写入 product_json 的 ProductDetail 包裹", () => {
  const product = parseAndNormalizeProductJson(JSON.stringify({
    id: "local-product-id",
    name: "杭州2天1晚私家团",
    product: {
      basicInfo: { supplierProductName: "杭州2天1晚私家团", days: 2 },
      operations: { vehicleResource: { requestedTotalCost: 800 } },
      itinerary: [{ day: 1, spots: [] }],
    },
    operations: {
      vehicleResource: { requestedTotalCost: 800, resourceGroupId: 2206275 },
    },
  })) as Record<string, any>;

  assert.equal(product.id, undefined);
  assert.equal(product.product, undefined);
  assert.equal(product.basicInfo.supplierProductName, "杭州2天1晚私家团");
  assert.equal(product.operations.vehicleResource.resourceGroupId, 2206275);
  assert.equal(product.itinerary.length, 1);
});
