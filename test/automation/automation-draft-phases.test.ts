import test from "node:test";
import assert from "node:assert/strict";
import { draftPhasesFor } from "../../src/main/automation/automation.main/automation.main.phases.js";
import { fillAndSubmitPricingInventory } from "../../src/main/automation/ctrip/pricing.js";
import { parseProduct } from "../../src/main/automation/schema/schema.js";

const baseProduct = {
  sales: { productType: "domesticShort", productForm: "groupTour", splitGroup: false },
  basicInfo: {
    supplierProductName: "太原2天1晚跟团游",
    supplierProductCode: "P001",
    subtitle: "太原经典行程",
    days: 1,
    nights: 0,
    meetingCity: "太原",
    destinationCity: "太原",
    province: "山西",
    operationNotes: "无",
  },
  itinerary: [
    {
      day: 1,
      title: "太原接站",
      spots: [{ name: "晋祠博物馆", poiName: "晋祠博物馆", poiId: 79413 }],
      description: "专车接站。",
      hotel: "",
      meals: "早餐自理；午餐自理；晚餐自理",
    },
  ],
};

const pricing = { adult: 599, child: 399, minimumTravelers: 2 };
const inventory = { startDate: "2026-09-01", endDate: "2026-09-30", dailyQuota: 10 };

test("draftPhasesFor: pricing 或 inventory 任一存在时包含 pricingInventory", () => {
  for (const commercial of [
    { packageName: "标准套餐", pricing },
    { packageName: "标准套餐", inventory },
    { packageName: "标准套餐", pricing, inventory },
  ]) {
    const product = parseProduct({ ...baseProduct, commercial });
    assert.ok(draftPhasesFor(product).includes("pricingInventory"));
  }
});

test("draftPhasesFor: pricing 和 inventory 都不存在时不包含 pricingInventory", () => {
  const withoutCommercial = parseProduct(baseProduct);
  const withoutPricingInventory = parseProduct({ ...baseProduct, commercial: { packageName: "标准套餐" } });

  assert.equal(draftPhasesFor(withoutCommercial).includes("pricingInventory"), false);
  assert.equal(draftPhasesFor(withoutPricingInventory).includes("pricingInventory"), false);
});

test("draftPhasesFor: 含住宿时也先提交行程，解锁后再创建套餐", () => {
  const product = parseProduct({
    ...baseProduct,
    basicInfo: { ...baseProduct.basicInfo, days: 2, nights: 1 },
    commercial: { packageName: "住宿套餐" },
    itinerary: [
      { ...baseProduct.itinerary[0], hotel: "当地4钻酒店" },
      { ...baseProduct.itinerary[0], day: 2, title: "太原送站", hotel: "" },
    ],
  });

  assert.deepEqual(
    draftPhasesFor(product).slice(0, 4),
    ["basic", "presentation", "itinerary", "package"],
  );
});

test("pricingInventory 阶段存在但 inventory 缺失时，由阶段处理器报告缺配置", async () => {
  const product = parseProduct({
    ...baseProduct,
    commercial: { packageName: "标准套餐", pricing },
  });

  await assert.rejects(
    () => fillAndSubmitPricingInventory(null, product, "7654321"),
    /commercial\.inventory/,
  );
});
