/**
 * draft-only release 安全测试：
 *  - 新建产品的 release.submitReview / publishAfterApproval 永远是 false；
 *  - AI 写 true 也被强制改写；
 *  - automationBlockers 会阻止 draft-only 之外的 publish 进入自动录入。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { normaliseProductDraft } from "../../src/main/data/product-normalize.js";
import { applyProductPatchSafe } from "../../src/main/operations/product-patch.js";
import { automationBlockers } from "../../src/main/automation/schema/schema-functions.js";
import { findBlacklistedKey, sanitiseModuleValue } from "../../src/main/planning/stage-runner.js";

test("新产品的 release 即使模型写 true 也会被强制为 false（safeRelease=true）", () => {
  const product = {
    sales: { productType: "domesticShort", productForm: "privateTour", splitGroup: false },
    basicInfo: { supplierProductName: "x", supplierProductCode: "NEW", subtitle: "y", days: 1, nights: 0, meetingCity: "Z", destinationCity: "Z", province: "Z", operationNotes: "n" },
    operations: { hotelSource: "nonPlatform", hotelTier: "当地5钻酒店/-38", transport: "charter", pickupCity: "Z", reusePickupForDropoff: true, mealsIncluded: false },
    commercial: { release: { submitReview: true, publishAfterApproval: true, publicPriceCeiling: 3000, publicAuditRetries: 4 } },
    itinerary: [],
  };
  // AI / 自动写入路径必须显式传 safeRelease=true；不传就是「保留历史发布标记」的语义，
  // 默认 preserveExistingRelease=true 的旧行为已被反转。这是本次回归的核心契约。
  const normalised = normaliseProductDraft(product, { safeRelease: true });
  const release = (normalised.commercial as { release: { submitReview: boolean; publishAfterApproval: boolean } }).release;
  assert.equal(release.submitReview, false);
  assert.equal(release.publishAfterApproval, false);
});

test("不传 safeRelease 时数据库启动 normalize 默认保留 release.submitReview=true", () => {
  // 历史产品 / 人工显式打开发布态不应被默默清零。这是 DB 启动 normalize 与
  // fixture 解析路径的默认行为：保留 submitReview / publishAfterApproval。
  const product = {
    commercial: { release: { submitReview: true, publishAfterApproval: true, publicPriceCeiling: 3000, publicAuditRetries: 4 } },
  };
  const normalised = normaliseProductDraft(product);
  const release = (normalised.commercial as { release: { submitReview: boolean; publishAfterApproval: boolean } }).release;
  assert.equal(release.submitReview, true);
  assert.equal(release.publishAfterApproval, true);
});

test("applyProductPatchSafe 写入 release=true 仍会被 normalise 强制 false", () => {
  const base = { commercial: {} };
  const result = applyProductPatchSafe(base, [{
    op: "replace", path: "/commercial/release", value: { submitReview: true, publishAfterApproval: true, publicPriceCeiling: 3000, publicAuditRetries: 4 },
  }]);
  assert.equal(result.applied, true);
  const release = (normaliseProductDraft(result.product).commercial as { release: { submitReview: boolean } }).release;
  assert.equal(release.submitReview, false);
});

test("automationBlockers 把 submitReview=true / publishAfterApproval=true 视为阻断", () => {
  const product = {
    sales: { productType: "domesticShort", productForm: "privateTour" as const, splitGroup: false },
    basicInfo: {
      supplierProductName: "x",
      supplierProductCode: "NEW",
      subtitle: "y",
      days: 1,
      nights: 0,
      meetingCity: "Z",
      destinationCity: "Z",
      province: "Z",
      operationNotes: "n",
    },
    operations: {
      hotelSource: "nonPlatform" as const,
      hotelTier: "当地5钻酒店/-38" as const,
      transport: "charter" as const,
      pickupCity: "Z",
      reusePickupForDropoff: true,
      mealsIncluded: false,
      vehicleResource: { resourceGroupId: 1, resourceGroupName: "x" },
    },
    presentation: {
      recommendation: "r",
      features: "f",
      recommendations: [
        { category: "优选行程" as const, text: "A" },
        { category: "精选酒店" as const, text: "B" },
        { category: "缤纷景点" as const, text: "C" },
      ],
    },
    itinerary: [{
      day: 1,
      title: "D",
      spots: [{ name: "S", poiName: null, poiId: null }],
      description: "D",
      hotel: "H",
      meals: "B/L/D",
    }],
    commercial: { release: { submitReview: true, publishAfterApproval: true, publicPriceCeiling: 3000, publicAuditRetries: 4 } },
  };
  const blockers = automationBlockers(product, { researchTasks: [] });
  assert.ok(blockers.some((b) => /submitReview/.test(b.label)));
  assert.ok(blockers.some((b) => /publishAfterApproval/.test(b.label)));
});

test("findBlacklistedKey 命中禁写字段名", () => {
  assert.equal(findBlacklistedKey({ supplierProductCode: "X" }), "supplierProductCode");
  assert.equal(findBlacklistedKey({ vehicleResource: { resourceId: 1 } }), "vehicleResource");
  assert.equal(findBlacklistedKey({ vehicleResource: { requestedDailyCost: 1000 } }), undefined);
  assert.equal(findBlacklistedKey({ vehicleId: 1 }), "vehicleId");
  assert.equal(findBlacklistedKey({ resourceId: 1 }), "resourceId");
  assert.equal(findBlacklistedKey({ resourceGroupId: 1 }), "resourceGroupId");
  assert.equal(findBlacklistedKey({ resourceGroupName: "x" }), "resourceGroupName");
  assert.equal(findBlacklistedKey({ supplierCode: "x" }), "supplierCode");
  assert.equal(findBlacklistedKey({ providerId: 1 }), "providerId");
  assert.equal(findBlacklistedKey({ contactCardId: 1 }), "contactCardId");
  assert.equal(findBlacklistedKey({ butler: { displayName: "x" } }), "butler");
  assert.equal(findBlacklistedKey({ bookingControls: {} }), "bookingControls");
  assert.equal(findBlacklistedKey([{ vehicleId: 1 }]), "vehicleId");
  assert.equal(findBlacklistedKey({ itinerary: [{ hotelResource: {} }] }), "hotelResource");
  // 合法的字段不被命中。
  assert.equal(findBlacklistedKey({ hotelTier: "当地5钻酒店/-38" }), undefined);
  assert.equal(findBlacklistedKey(null), undefined);
});

test("operations 阶段只允许 AI 写 vehicleResource.requestedDailyCost", () => {
  assert.deepEqual(
    sanitiseModuleValue("skeleton", { vehicleResource: { requestedDailyCost: 1000 } }),
    { ok: true, value: { vehicleResource: { requestedDailyCost: 1000 } } },
  );
  assert.deepEqual(
    sanitiseModuleValue("skeleton", { vehicleResource: { resourceGroupId: 101 } }),
    { ok: false, reason: "AI 输出包含禁写字段 vehicleResource" },
  );
});
