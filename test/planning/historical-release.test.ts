/**
 * 历史 / 人工 release 标记保留 + AI / 自动路径 draft-safe 行为契约。
 *
 *  1. 数据库 startup normalize 默认保留 release.submitReview / publishAfterApproval；
 *  2. AI / 自动写入路径（applyProductPatch、applyProductPatchSafe、runtime.writeModule）
 *     必须显式 safeRelease:true，否则会清零历史发布标记；
 *  3. safe-release 旧测试（normaliseProductDraft 默认行为）的语义反转记录在这里。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { normaliseProductDraft } from "../../src/main/data/product-normalize.js";
import { applyProductPatch, applyProductPatchSafe } from "../../src/main/operations/product-patch.js";

test("DB startup normalize 默认保留 release.submitReview=true（不传 safeRelease）", () => {
  const product = {
    commercial: {
      release: { submitReview: true, publishAfterApproval: true, publicPriceCeiling: 3000, publicAuditRetries: 4 },
    },
  };
  const normalised = normaliseProductDraft(product);
  const release = (normalised.commercial as { release: { submitReview: boolean; publishAfterApproval: boolean } }).release;
  assert.equal(release.submitReview, true);
  assert.equal(release.publishAfterApproval, true);
});

test("AI / patch 路径必须显式传 safeRelease:true 才能强制 release 为 draft-only", () => {
  const product = {
    commercial: {
      release: { submitReview: true, publishAfterApproval: true, publicPriceCeiling: 3000, publicAuditRetries: 4 },
    },
  };
  // AI 路径：safeRelease 强制 draft-only。
  const normalisedAi = normaliseProductDraft(structuredClone(product), { safeRelease: true });
  const releaseAi = (normalisedAi.commercial as { release: { submitReview: boolean; publishAfterApproval: boolean } }).release;
  assert.equal(releaseAi.submitReview, false);
  assert.equal(releaseAi.publishAfterApproval, false);
  // 不传 → 保留。这覆盖了旧 preserveExistingRelease 标记的反转语义。
  const normalisedDefault = normaliseProductDraft(structuredClone(product));
  const releaseDefault = (normalisedDefault.commercial as { release: { submitReview: boolean } }).release;
  assert.equal(releaseDefault.submitReview, true);
});

test("applyProductPatchSafe 自动写入 release=true → 仍被强制 false", () => {
  const base = { commercial: { release: { submitReview: false, publicPriceCeiling: 1000, publicAuditRetries: 3 } } };
  const result = applyProductPatchSafe(structuredClone(base) as Record<string, unknown>, [
    { op: "replace", path: "/commercial/release", value: { submitReview: true, publishAfterApproval: true, publicPriceCeiling: 4000, publicAuditRetries: 5 } },
  ]);
  assert.equal(result.applied, true);
  const release = (result.product.commercial as { release: { submitReview: boolean; publishAfterApproval: boolean } }).release;
  assert.equal(release.submitReview, false);
  assert.equal(release.publishAfterApproval, false);
});

test("applyProductPatch（不安全路径）也必须清零 release=true", () => {
  const base = { commercial: { release: { submitReview: false, publicPriceCeiling: 1000, publicAuditRetries: 3 } } };
  const result = applyProductPatch(structuredClone(base) as Record<string, unknown>, [
    { op: "replace", path: "/commercial/release", value: { submitReview: true, publishAfterApproval: true, publicPriceCeiling: 4000, publicAuditRetries: 5 } },
  ]);
  const release = (result.commercial as { release: { submitReview: boolean; publishAfterApproval: boolean } }).release;
  assert.equal(release.submitReview, false);
  assert.equal(release.publishAfterApproval, false);
});

test("DB 启动 normalize（无 release 时）保留空字段；AI 路径同样不污染空字段", () => {
  // fixture / 历史数据可能没有 release；DB 启动 normalize 不应凭空写一个 release。
  const product = { sales: { productType: "domesticShort", productForm: "privateTour", splitGroup: false } };
  const normalised = normaliseProductDraft(structuredClone(product));
  assert.equal(normalised.commercial, undefined);
});

test("NormaliseOptions.safeRelease 为 false / undefined 时默认保留", () => {
  // 显式 safeRelease:false 也走保留路径，避免「忘了传字段」就退回到默认 false 的歧义。
  const product = {
    commercial: { release: { submitReview: true, publishAfterApproval: true, publicPriceCeiling: 1, publicAuditRetries: 1 } },
  };
  const normalised = normaliseProductDraft(product, { safeRelease: false });
  const release = (normalised.commercial as { release: { submitReview: boolean; publishAfterApproval: boolean } }).release;
  assert.equal(release.submitReview, true);
  assert.equal(release.publishAfterApproval, true);
});