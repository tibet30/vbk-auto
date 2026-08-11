/**
 * 资源 / 人工数据保护 + 自动化阻断一致性测试：
 *  - normaliseProductDraft 不会删除 vehicleResource / hotelResource / butler / bookingControls；
 *  - 旧的商业 research task 不再阻断规划 / 草稿 readiness；
 *  - release.submitReview / publishAfterApproval=true 阻断自动化（草稿默认安全）；
 *  - 未填 vehicleResource 的私家团被 automationBlockers 阻断；
 *  - 数据库 normalizeStoredProducts 不会把 vehicleResource / hotelResource / butler
 *    等运营数据无故清掉。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { normaliseProductDraft } from "../../src/main/data/product-normalize.js";
import { automationBlockers } from "../../src/main/automation/schema/schema-functions.js";

test("normaliseProductDraft 保留 vehicleResource / hotelResource / butler / bookingControls", () => {
  const product = {
    sales: { productType: "domesticShort", productForm: "privateTour", splitGroup: false },
    basicInfo: { supplierProductName: "x", supplierProductCode: "NEW", subtitle: "y", days: 2, nights: 1, meetingCity: "Z", destinationCity: "Z", province: "Z", operationNotes: "n" },
    operations: {
      hotelSource: "nonPlatform",
      hotelTier: "当地5钻酒店/-38",
      transport: "charter",
      pickupCity: "Z",
      reusePickupForDropoff: true,
      mealsIncluded: false,
      vehicleResource: { resourceGroupId: 12345, vehicleId: 67890 },
      hotelResource: { resourceId: 11111 },
      butler: { contactCardId: 222 },
      bookingControls: { advanceBooking: { days: 1, time: "12:00" } },
    },
    itinerary: [{ day: 1, title: "D", spots: [{ name: "A", poiName: null, poiId: null }], description: "D", meals: "M" }],
  };
  const normalised = normaliseProductDraft(product);
  const operations = normalised.operations as Record<string, unknown>;
  assert.ok(operations.vehicleResource, "vehicleResource 仍保留");
  assert.ok(operations.hotelResource, "hotelResource 仍保留");
  assert.ok(operations.butler, "butler 仍保留");
  assert.ok(operations.bookingControls, "bookingControls 仍保留");
});

test("automationBlockers 在缺少 vehicleResource 时阻断（privateTour）", () => {
  const product = {
    sales: { productForm: "privateTour" },
    commercial: {
      pricing: { currency: "CNY", adult: 1000, child: 500, minimumTravelers: 2 },
      inventory: { startDate: "2026-08-10", endDate: "2026-12-31", dailyQuota: 6 },
      release: { submitReview: false, publishAfterApproval: false, publicPriceCeiling: 3000, publicAuditRetries: 4 },
    },
  };
  const blockers = automationBlockers(product, { researchTasks: [] });
  assert.ok(blockers.some((b) => /用车资源组/.test(b.label)));
});

test("未解决的车辆 research task 在 vehicleResource 已填完整时不再阻断自动化", () => {
  const product = {
    sales: { productForm: "privateTour" },
    commercial: {
      pricing: { currency: "CNY", adult: 1000, child: 500, minimumTravelers: 2 },
      inventory: { startDate: "2026-08-10", endDate: "2026-12-31", dailyQuota: 6 },
      release: { submitReview: false, publishAfterApproval: false, publicPriceCeiling: 3000, publicAuditRetries: 4 },
    },
    operations: { vehicleResource: { resourceGroupId: 1, resourceGroupName: "5座经济550+..." } },
  };
  const tasks = [
    { state: "researching", label: "核查用车资源组", type: "vbk" },
  ];
  const blockers = automationBlockers(product, { researchTasks: tasks });
  const labels = blockers.map((b) => b.label);
  assert.ok(!labels.some((l) => l === "用车资源组"));
  assert.ok(!labels.some((l) => /车辆核查/.test(l)), `车辆 research task 已满足后不应阻断：${labels.join(",")}`);
});

test("vehicleResource 缺少 resourceGroupName 时仍阻断（privateTour）", () => {
  const product = {
    sales: { productForm: "privateTour" },
    commercial: {
      pricing: { currency: "CNY", adult: 1000, child: 500, minimumTravelers: 2 },
      inventory: { startDate: "2026-08-10", endDate: "2026-12-31", dailyQuota: 6 },
      release: { submitReview: false, publishAfterApproval: false, publicPriceCeiling: 3000, publicAuditRetries: 4 },
    },
    operations: { vehicleResource: { resourceGroupId: 1 } },
  };
  const blockers = automationBlockers(product, { researchTasks: [] });
  assert.ok(blockers.some((b) => /用车资源组/.test(b.label)));
});

test("缺少 vehicleResource 且存在车辆 research task 时只生成一个车辆类 blocker", () => {
  const product = {
    sales: { productForm: "privateTour" },
    commercial: {
      pricing: { currency: "CNY", adult: 1000, child: 500, minimumTravelers: 2 },
      inventory: { startDate: "2026-08-10", endDate: "2026-12-31", dailyQuota: 6 },
      release: { submitReview: false, publishAfterApproval: false, publicPriceCeiling: 3000, publicAuditRetries: 4 },
    },
    operations: { vehicleResource: {} },
  };
  const tasks = [
    { state: "researching", label: "核查用车资源组", type: "vbk" },
  ];
  const blockers = automationBlockers(product, { researchTasks: tasks });
  const vehicleBlockers = blockers.filter((b) => /用车|车辆|资源组/.test(`${b.label} ${b.detail}`));
  assert.equal(vehicleBlockers.length, 1);
  assert.equal(vehicleBlockers[0].label, "用车资源组");
  assert.match(vehicleBlockers[0].detail, /私家团需要在 VBK 核查并填写现有用车资源组 ID/);
});

test("release.submitReview=true 阻断自动化；false 不阻断", () => {
  const onProduct = {
    sales: { productForm: "privateTour" },
    commercial: {
      pricing: { currency: "CNY", adult: 1000, child: 500, minimumTravelers: 2 },
      inventory: { startDate: "2026-08-10", endDate: "2026-12-31", dailyQuota: 6 },
      release: { submitReview: true, publishAfterApproval: false, publicPriceCeiling: 3000, publicAuditRetries: 4 },
    },
    operations: { vehicleResource: { resourceGroupId: 1, resourceGroupName: "X" } },
  };
  const blockers = automationBlockers(onProduct, { researchTasks: [] });
  assert.ok(blockers.some((b) => /submitReview/.test(b.label)));

  const offProduct = {
    ...onProduct,
    commercial: {
      ...onProduct.commercial,
      release: { submitReview: false, publishAfterApproval: false, publicPriceCeiling: 3000, publicAuditRetries: 4 },
    },
  };
  const blockersOff = automationBlockers(offProduct, { researchTasks: [] });
  assert.ok(!blockersOff.some((b) => /submitReview/.test(b.label)));
});

test("normaliseProductDraft 默认不反转 release.submitReview=true（保留历史值）", () => {
  // DB startup / fixture 解析 / 历史产品加载时，normaliseProductDraft 不应把人工
  // 或 VBK 已经打开的发布态默默清零。AI / 自动写入路径必须显式传 safeRelease=true
  // 才能走「强制 draft-only」语义。本测试验证默认路径下保留 release=true。
  const product = {
    sales: { productType: "domesticShort", productForm: "privateTour", splitGroup: false },
    basicInfo: { supplierProductName: "x", supplierProductCode: "NEW", subtitle: "y", days: 1, nights: 0, meetingCity: "Z", destinationCity: "Z", province: "Z", operationNotes: "n" },
    operations: { hotelSource: "nonPlatform", hotelTier: "当地5钻酒店/-38", transport: "charter", pickupCity: "Z", reusePickupForDropoff: true, mealsIncluded: false },
    commercial: {
      release: { submitReview: true, publishAfterApproval: true, publicPriceCeiling: 3000, publicAuditRetries: 4 },
    },
    itinerary: [],
  };
  const preserved = normaliseProductDraft(product);
  const release = (preserved.commercial as { release: { submitReview: boolean; publishAfterApproval: boolean } }).release;
  assert.equal(release.submitReview, true);
  assert.equal(release.publishAfterApproval, true);

  // 反向断言：AI / patch 路径显式传 safeRelease:true，会强制为 false。
  const aiForced = normaliseProductDraft(product, { safeRelease: true });
  const aiRelease = (aiForced.commercial as { release: { submitReview: boolean; publishAfterApproval: boolean } }).release;
  assert.equal(aiRelease.submitReview, false);
  assert.equal(aiRelease.publishAfterApproval, false);
});
