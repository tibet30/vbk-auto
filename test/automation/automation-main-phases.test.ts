import test from "node:test";
import assert from "node:assert/strict";
import { draftPhasesFor } from "../../src/main/automation/automation.main/automation.main.phases.js";
import { fillAndSubmitPricingInventory } from "../../src/main/automation/ctrip/pricing.js";
import { parseProduct } from "../../src/main/automation/schema/schema.js";

function makeProduct(commercial?: Record<string, unknown>) {
  return parseProduct({
    sales: { productType: "domesticShort", productForm: "groupTour", splitGroup: false },
    basicInfo: {
      supplierProductName: "太原1日跟团游",
      supplierProductCode: "TEST-PRICE-1",
      subtitle: "太原经典一日游",
      days: 1,
      nights: 0,
      meetingCity: "太原",
      destinationCity: "太原",
      province: "山西",
      operationNotes: "测试",
    },
    commercial,
    itinerary: [
      {
        day: 1,
        title: "太原市区游",
        spots: [{ name: "晋祠博物馆", poiName: "晋祠博物馆", poiId: 79413 }],
        description: "游览晋祠博物馆。",
        hotel: "",
        meals: "早餐自理；午餐自理；晚餐自理",
      },
    ],
  });
}

test("只有 pricing 时包含 pricingInventory 阶段", () => {
  const product = makeProduct({
    packageName: "标准套餐",
    pricing: { currency: "CNY", adult: 599, child: 399, minimumTravelers: 2 },
  });

  assert.ok(draftPhasesFor(product).includes("pricingInventory"));
});

test("缺少 AI terms 时仍包含 VBK terms 阶段", () => {
  assert.equal(draftPhasesFor(makeProduct()).includes("terms"), true);
});

test("只有 inventory 时包含 pricingInventory 阶段", () => {
  const product = makeProduct({
    packageName: "标准套餐",
    inventory: { startDate: "2026-09-01", endDate: "2026-09-30", dailyQuota: 10 },
  });

  assert.ok(draftPhasesFor(product).includes("pricingInventory"));
});

test("没有 pricing 和 inventory 时不包含 pricingInventory 阶段", () => {
  assert.equal(draftPhasesFor(makeProduct()).includes("pricingInventory"), false);
  assert.equal(draftPhasesFor(makeProduct({ packageName: "标准套餐" })).includes("pricingInventory"), false);
});

test("半完整商业数据进入 pricingInventory 后由阶段处理器报告缺配置", async () => {
  const product = makeProduct({
    packageName: "标准套餐",
    pricing: { currency: "CNY", adult: 599, child: 399, minimumTravelers: 2 },
  });

  await assert.rejects(
    () => fillAndSubmitPricingInventory(null, product, "7654321"),
    /commercial\.inventory/,
  );
});
