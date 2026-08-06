import test from "node:test";
import assert from "node:assert/strict";
import { automationBlockers, productSchema } from "../../src/main/automation/schema/schema.js";
import { isCoverResearchTaskSatisfiedByProduct } from "../../src/main/minimax/minimax.js";

const baseProduct = {
  sales: { productType: "domesticShort", productForm: "groupTour", splitGroup: false },
  basicInfo: { supplierProductName: "太原2天1晚跟团游" },
  itinerary: [{ day: 1 }],
};

const commercial = {
  packageName: "标准套餐",
  pricing: { adult: 599, child: 399, minimumTravelers: 2 },
};

const validProduct = {
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
  itinerary: [{ day: 1, title: "游览", spots: [], description: "", hotel: "", meals: "" }],
  commercial,
};

test("缺少 commercial 会被列为录入阻塞项", () => {
  const blockers = automationBlockers(baseProduct);
  assert.deepEqual(blockers.map((item) => item.label), ["套餐与价格"]);
});

test("缺少 packageName 会被列为阻塞项", () => {
  const blockers = automationBlockers({ ...baseProduct, commercial: { pricing: commercial.pricing } });
  assert.deepEqual(blockers.map((item) => item.label), ["套餐名称"]);
});

test("缺少 pricing 会被列为阻塞项", () => {
  const blockers = automationBlockers({ ...baseProduct, commercial: { packageName: commercial.packageName } });
  assert.deepEqual(blockers.map((item) => item.label), ["价格"]);
});

test("仅有 packageName 和 pricing 的跟团游通过", () => {
  assert.deepEqual(automationBlockers({ ...baseProduct, commercial }), []);
});

test("缺少 inventory 和 terms 不阻塞", () => {
  const blockers = automationBlockers({ ...baseProduct, commercial });
  assert.equal(blockers.some((item) => item.label === "库存" || item.label === "条款"), false);
});

test("私家团缺少用车资源组会被拦下", () => {
  const product = {
    ...baseProduct,
    sales: { ...baseProduct.sales, productForm: "privateTour" },
    commercial,
  };
  const blockers = automationBlockers(product);
  assert.deepEqual(blockers.map((item) => item.label), ["用车资源组"]);
});

test("私家团配齐用车资源组后通过", () => {
  const product = {
    ...baseProduct,
    sales: { ...baseProduct.sales, productForm: "privateTour" },
    commercial,
    operations: { vehicleResource: { resourceGroupId: 88231, resourceGroupName: "太原用车组" } },
  };
  assert.deepEqual(automationBlockers(product), []);
});

test("完整 cover 只覆盖 image research task", () => {
  const product = {
    ...validProduct,
    presentation: {
      recommendation: "推荐",
      features: "特色",
      cover: { source: "ctripLibrary", poi: "云冈石窟", description: "横版云冈石窟外景或代表性造像", minQuality: 3 },
    },
  };
  assert.equal(isCoverResearchTaskSatisfiedByProduct({ type: "image" }, product), true);
  for (const type of ["vbk", "web", "cost"]) {
    assert.equal(isCoverResearchTaskSatisfiedByProduct({ type }, product), false);
  }
});

test("inventory 存在但结构非法时 productSchema 报错", () => {
  const result = productSchema.safeParse({
    ...validProduct,
    commercial: { ...commercial, inventory: { startDate: "invalid", endDate: "2026-12-31", dailyQuota: 10 } },
  });
  assert.equal(result.success, false);
  assert.ok(result.error.issues.some((issue) => issue.path.join(".") === "commercial.inventory.startDate"));
});

test("terms 存在但结构非法时 productSchema 报错", () => {
  const result = productSchema.safeParse({
    ...validProduct,
    commercial: { ...commercial, terms: { inclusions: "" } },
  });
  assert.equal(result.success, false);
  assert.ok(result.error.issues.some((issue) => issue.path.join(".") === "commercial.terms.inclusions"));
});
