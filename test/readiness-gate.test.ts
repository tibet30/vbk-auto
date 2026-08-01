import test from "node:test";
import assert from "node:assert/strict";
import { automationBlockers } from "../src/main/automation/schema.js";

const baseProduct = {
  sales: { productType: "domesticShort", productForm: "groupTour", splitGroup: false },
  basicInfo: { supplierProductName: "太原2天1晚跟团游" },
  itinerary: [{ day: 1 }],
};

const fullCommercial = {
  packageName: "标准套餐",
  pricing: { adult: 599, child: 399, minimumTravelers: 2 },
  inventory: { startDate: "2026-09-01", endDate: "2026-12-31", dailyQuota: 10 },
  terms: { inclusions: "含", exclusions: "不含", bookingNotes: "须知", refundPolicy: "退改" },
};

test("缺少 commercial 会被列为录入阻塞项", () => {
  // 此前 readiness 只看 productSchema（commercial 可选），界面显示「可以录入」，
  // 自动化却会在携程创建草稿之后才因缺 commercial 失败，留下半成品。
  const blockers = automationBlockers(baseProduct);
  assert.ok(blockers.length > 0);
  assert.match(blockers[0].label, /套餐/);
});

test("commercial 齐全的跟团游没有阻塞项", () => {
  const blockers = automationBlockers({ ...baseProduct, commercial: fullCommercial });
  assert.deepEqual(blockers, []);
});

test("私家团缺少用车资源组会被拦下", () => {
  const product = {
    ...baseProduct,
    sales: { ...baseProduct.sales, productForm: "privateTour" },
    commercial: fullCommercial,
  };

  const blockers = automationBlockers(product);
  assert.equal(blockers.length, 1);
  assert.match(blockers[0].label, /用车资源组/);
});

test("私家团配齐用车资源组后通过", () => {
  const product = {
    ...baseProduct,
    sales: { ...baseProduct.sales, productForm: "privateTour" },
    commercial: fullCommercial,
    operations: { vehicleResource: { resourceGroupId: 88231, resourceGroupName: "太原用车组" } },
  };

  assert.deepEqual(automationBlockers(product), []);
});

test("commercial 局部缺失会逐项指出", () => {
  const blockers = automationBlockers({
    ...baseProduct,
    commercial: { packageName: "标准套餐", pricing: fullCommercial.pricing },
  });

  const labels = blockers.map((item) => item.label);
  assert.ok(labels.includes("库存"));
  assert.ok(labels.includes("条款"));
});
