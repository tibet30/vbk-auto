import test from "node:test";
import assert from "node:assert/strict";
import { applyProductPatch } from "../src/main/product-patch.js";

test("草稿字段使用 replace 时会创建尚不存在的父对象", () => {
  const product = { basicInfo: { supplierProductName: "太原2天1晚私家团" }, itinerary: [] };

  const result = applyProductPatch(product, [
    { op: "replace", path: "/commercial/packageName", value: "太原2天1晚标准套餐" },
  ]);

  assert.deepEqual(result.commercial, { packageName: "太原2天1晚标准套餐" });
  assert.equal("commercial" in product, false);
});

test("应用新补丁时会同步修正已有的 MiniMax 展示和行程结构", () => {
  const product = {
    basicInfo: { supplierProductName: "太原2天1晚私家团" },
    presentation: { productName: "太原私家团", highlights: ["专车服务"], description: "两天探访太原。" },
    itinerary: [{ day: 1, title: "晋祠探古", summary: "游览晋祠", activities: [{ name: "晋祠博物馆", detail: "参观古建" }], meals: { breakfast: "自理", lunch: "自理", dinner: "自理" }, stay: "太原酒店" }],
  };

  const result = applyProductPatch(product, [{ op: "add", path: "/basicInfo/province", value: "山西" }]);

  assert.deepEqual(result.presentation, { recommendationCategory: "优选行程", recommendation: "两天探访太原。", features: "专车服务" });
  assert.equal((result.itinerary as Array<Record<string, unknown>>)[0].meals, "早餐自理；午餐自理；晚餐自理");
  assert.deepEqual((result.itinerary as Array<Record<string, unknown>>)[0].spots, ["晋祠博物馆"]);
});

test("草稿归一化会移除无效运营占位值", () => {
  const product = {
    operations: { transport: "", pickupCity: "", reusePickupForDropoff: null, hotelSource: "", hotelTier: "待核查", mealsIncluded: "待核查" },
    commercial: { packageName: "", terms: "待核查" },
    itinerary: [],
  };

  const result = applyProductPatch(product, [{ op: "add", path: "/basicInfo/province", value: "山西" }]);

  assert.equal(result.operations, undefined);
  assert.equal(result.commercial, undefined);
});
