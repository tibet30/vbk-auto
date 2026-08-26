import assert from "node:assert/strict";
import test from "node:test";
import {
  normaliseProductLocationFields,
  toPlatformShortLocationName,
} from "../../src/shared/location-short-name.js";

test("行政地点使用平台常用短名，最长尾缀优先", () => {
  assert.equal(toPlatformShortLocationName("成都市"), "成都");
  assert.equal(toPlatformShortLocationName("四川省"), "四川");
  assert.equal(toPlatformShortLocationName("新疆维吾尔自治区"), "新疆");
  assert.equal(toPlatformShortLocationName("延边朝鲜族自治州"), "延边");
  assert.equal(toPlatformShortLocationName("甘南藏族自治州"), "甘南");
  assert.equal(toPlatformShortLocationName("红河哈尼族彝族自治州"), "红河");
  assert.equal(toPlatformShortLocationName("阿坝藏族羌族自治州"), "阿坝");
  assert.equal(toPlatformShortLocationName("西湖区"), "西湖");
  for (const city of ["杭州", "广州", "苏州", "郑州", "福州", "兰州"]) {
    assert.equal(toPlatformShortLocationName(city), city);
  }
});

test("景区、城区和其它非行政名称不被误裁", () => {
  for (const value of ["宽窄巷子景区", "成都市区", "高新区园区", "老城片区", "大学校区", "矿区"]) {
    assert.equal(toPlatformShortLocationName(value), value);
  }
});

test("产品地点归一以 meetingCity 优先，并只处理明确地点字段", () => {
  const product = normaliseProductLocationFields({
    basicInfo: {
      meetingCity: "成都",
      destinationCity: "西安市",
      province: "四川省",
      destination: "成都市",
    },
    operations: { pickupCity: "西安市" },
    itinerary: [{ spots: [{ name: "宽窄巷子景区" }] }],
  });
  assert.equal((product.basicInfo as any).meetingCity, "成都");
  assert.equal((product.basicInfo as any).destinationCity, "成都");
  assert.equal((product.basicInfo as any).province, "四川");
  assert.equal((product.basicInfo as any).destination, "成都");
  assert.equal((product.operations as any).pickupCity, "西安");
  assert.equal((product.itinerary as any)[0].spots[0].name, "宽窄巷子景区");
});
