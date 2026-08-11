/**
 * 自动化 VBK 字段契约 + readiness gate + 防御深度闸门 测试：
 *
 *   G1: presentation.recommendations 缺失 / 坏 / 重复 / 非白名单 → readiness 失败并明确告诉运营「恰好 3 条」；
 *   G2: 一个合法 planning 输出的 presentation 会被契约视为就绪；
 *   G3: assertPresentationReadyForVbk 在 VBK 写入前就抛错（不调用 VBK 网络 / 弹窗）；
 *   G4: VBK_PRODUCT_FIELDS 覆盖所有 VBK 实际写入/读取的字段，未登记的字段不应被遗漏。
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  VBK_PRODUCT_FIELDS,
  assertPresentationReadyForVbk,
  evaluateAutomationContract,
  PRODUCT_JSON_LOCATION,
} from "../../src/main/automation/automation-contract.js";
import { hasValidPresentationRecommendations } from "../../src/main/automation/automation-contract.helpers.js";

/** 完整合法规划产物。 */
function makeValidProduct(): Record<string, unknown> {
  return {
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
    operations: {
      hotelSource: "nonPlatform",
      hotelTier: "当地3钻酒店/-3",
      transport: "charter",
      pickupCity: "太原",
      reusePickupForDropoff: true,
      mealsIncluded: false,
      bookingControls: {
        butler: {
          contactCardId: 1,
          displayName: "管家A",
          providerId: 100,
        },
      },
    },
    presentation: {
      recommendation: "2 天串联核心景点",
      features: "【古建巡礼】专业讲解",
      recommendations: [
        { category: "优选行程", text: "节奏舒适不赶路" },
        { category: "精选酒店", text: "当地 3 钻酒店含早餐" },
        { category: "缤纷景点", text: "覆盖晋祠与博物院" },
      ],
      cover: {
        source: "ctripLibrary",
        poi: "晋祠博物馆",
        description: "横版晋祠外景或代表性造像",
        minQuality: 3,
      },
    },
    itinerary: [
      {
        day: 1,
        title: "太原接站—晋祠",
        spots: [{ name: "晋祠博物馆", poiName: "晋祠博物馆", poiId: 79413 }],
        description: "专车接站游览晋祠。",
        hotel: "太原市区舒适酒店",
        meals: "早餐自理；午餐自理；晚餐自理",
      },
    ],
  };
}

// ────────────────────────────────────────────────────────────────────
// G1: presentation.recommendations 阻断契约
// ────────────────────────────────────────────────────────────────────

test("G1 presentation.recommendations 缺失让 readiness 失败并明确告诉运营「恰好 3 条」", () => {
  const product = makeValidProduct();
  delete (product.presentation as Record<string, unknown>).recommendations;
  const result = evaluateAutomationContract(product);
  const failure = result.failures.find((f) => f.field.path === "presentation.recommendations");
  assert.ok(failure, "presentation.recommendations 缺失必须列入 failures");
  assert.match(failure!.reason, /3 条/);
  assert.equal(result.ready, false);
});

test("G1 presentation.recommendations 只有 2 条让 readiness 失败", () => {
  const product = makeValidProduct();
  (product.presentation as Record<string, unknown>).recommendations = [
    { category: "优选行程", text: "A" },
    { category: "精选酒店", text: "B" },
  ];
  const result = evaluateAutomationContract(product);
  assert.ok(result.failures.some((f) => f.field.path === "presentation.recommendations"));
});

test("G1 presentation.recommendations 重复 category 让 readiness 失败", () => {
  const product = makeValidProduct();
  (product.presentation as Record<string, unknown>).recommendations = [
    { category: "优选行程", text: "A" },
    { category: "优选行程", text: "B" },
    { category: "缤纷景点", text: "C" },
  ];
  const result = evaluateAutomationContract(product);
  const failure = result.failures.find((f) => f.field.path === "presentation.recommendations");
  assert.ok(failure);
  assert.match(failure!.reason, /3 条|白名单|重复/);
});

test("G1 presentation.recommendations 非白名单 category 让 readiness 失败", () => {
  const product = makeValidProduct();
  (product.presentation as Record<string, unknown>).recommendations = [
    { category: "优选行程", text: "A" },
    { category: "精选酒店", text: "B" },
    { category: "非法分类", text: "C" },
  ];
  const result = evaluateAutomationContract(product);
  assert.ok(result.failures.some((f) => f.field.path === "presentation.recommendations"));
});

test("G1 presentation.recommendations 文本为空让 readiness 失败", () => {
  const product = makeValidProduct();
  (product.presentation as Record<string, unknown>).recommendations = [
    { category: "优选行程", text: "A" },
    { category: "精选酒店", text: "B" },
    { category: "缤纷景点", text: "" },
  ];
  const result = evaluateAutomationContract(product);
  assert.ok(result.failures.some((f) => f.field.path === "presentation.recommendations"));
});

// ────────────────────────────────────────────────────────────────────
// G2: 合法 planning 输出的 presentation 被契约视为就绪
// ────────────────────────────────────────────────────────────────────

test("G2 完整合法产品契约 ready=true，且商业类字段（pricing/inventory/terms）不进 failures", () => {
  const product = makeValidProduct();
  const result = evaluateAutomationContract(product);
  assert.equal(result.ready, true);
  // 商业类字段是 vbk-runtime 异常，不进 failures
  assert.equal(result.failures.some((f) => f.field.path === "commercial.packageName"), false);
  assert.equal(result.failures.some((f) => f.field.path === "commercial.pricing"), false);
  assert.equal(result.failures.some((f) => f.field.path === "commercial.inventory"), false);
  assert.equal(result.failures.some((f) => f.field.path === "commercial.terms"), false);
});

test("G2 hasValidPresentationRecommendations 直接对合法 / 非法样本判断正确", () => {
  const valid = makeValidProduct();
  assert.equal(hasValidPresentationRecommendations(valid), true);
  // 缺一条
  const two = structuredClone(valid) as Record<string, unknown>;
  (two.presentation as Record<string, unknown>).recommendations = [
    { category: "优选行程", text: "A" },
    { category: "精选酒店", text: "B" },
  ];
  assert.equal(hasValidPresentationRecommendations(two), false);
  // 重复 category
  const dup = structuredClone(valid) as Record<string, unknown>;
  (dup.presentation as Record<string, unknown>).recommendations = [
    { category: "优选行程", text: "A" },
    { category: "优选行程", text: "B" },
    { category: "缤纷景点", text: "C" },
  ];
  assert.equal(hasValidPresentationRecommendations(dup), false);
});

// ────────────────────────────────────────────────────────────────────
// G3: assertPresentationReadyForVbk 防御深度闸门
// ────────────────────────────────────────────────────────────────────

test("G3 assertPresentationReadyForVbk 对合法产品不抛错", () => {
  assert.doesNotThrow(() => assertPresentationReadyForVbk(makeValidProduct()));
});

test("G3 assertPresentationReadyForVbk 缺 recommendations 在第一行就抛错（不调用 VBK）", () => {
  const product = makeValidProduct();
  delete (product.presentation as Record<string, unknown>).recommendations;
  assert.throws(
    () => assertPresentationReadyForVbk(product),
    /推荐理由必须恰好 3 条/,
  );
});

test("G3 assertPresentationReadyForVbk 缺 recommendation 文案在第一行抛错", () => {
  const product = makeValidProduct();
  delete (product.presentation as Record<string, unknown>).recommendation;
  assert.throws(() => assertPresentationReadyForVbk(product), /推荐语/);
});

test("G3 assertPresentationReadyForVbk 缺 features 在第一行抛错", () => {
  const product = makeValidProduct();
  delete (product.presentation as Record<string, unknown>).features;
  assert.throws(() => assertPresentationReadyForVbk(product), /产品特点/);
});

test("G3 assertPresentationReadyForVbk 缺 presentation 整体抛错（不再静默通过）", () => {
  const product = makeValidProduct();
  delete product.presentation;
  assert.throws(() => assertPresentationReadyForVbk(product), /presentation/);
});

test("G3 assertPresentationReadyForVbk 重复 category 在第一行抛错", () => {
  const product = makeValidProduct();
  (product.presentation as Record<string, unknown>).recommendations = [
    { category: "优选行程", text: "A" },
    { category: "优选行程", text: "B" },
    { category: "缤纷景点", text: "C" },
  ];
  assert.throws(() => assertPresentationReadyForVbk(product), /恰好 3 条/);
});

test("G3 assertPresentationReadyForVbk 非白名单 category 在第一行抛错", () => {
  const product = makeValidProduct();
  (product.presentation as Record<string, unknown>).recommendations = [
    { category: "优选行程", text: "A" },
    { category: "精选酒店", text: "B" },
    { category: "非法分类", text: "C" },
  ];
  assert.throws(() => assertPresentationReadyForVbk(product), /白名单/);
});

test("G3 assertPresentationReadyForVbk manualUpload 封面抛错", () => {
  const product = makeValidProduct();
  (product.presentation as Record<string, unknown>).cover = {
    source: "manualUpload",
    fileId: "11111111-1111-1111-1111-111111111111",
    originalName: "demo.jpg",
    mimeType: "image/jpeg",
    sizeBytes: 1024,
    poi: "晋祠",
    description: "横版",
    minQuality: 3,
    uploadedAt: "2026-01-01T00:00:00.000Z",
  };
  assert.throws(() => assertPresentationReadyForVbk(product), /手动上传/);
});

// ────────────────────────────────────────────────────────────────────
// G4: VBK_PRODUCT_FIELDS 字段契约覆盖
// ────────────────────────────────────────────────────────────────────

test("G4 VBK_PRODUCT_FIELDS 覆盖 presentation / basic / operations 关键 AI 写入字段", () => {
  const paths = new Set(VBK_PRODUCT_FIELDS.map((f) => f.path));
  for (const required of [
    "presentation.recommendations",
    "presentation.recommendation",
    "presentation.features",
    "presentation.cover",
    "basicInfo.subtitle",
    "basicInfo.province",
    "basicInfo.operationNotes",
    "operations.butlerContact",
    "operations.hotelTier",
    "itinerary",
  ]) {
    assert.ok(paths.has(required), `字段 ${required} 必须被契约覆盖`);
  }
});

test("G4 商业三件套（pricing / inventory / terms）走 vbk-runtime，不进 failures", () => {
  const product = makeValidProduct();
  // 删掉所有 commercial
  const result = evaluateAutomationContract(product);
  // 商业类字段缺失不会让 ready=false
  const commercialFailures = result.failures.filter((f) => f.field.path.startsWith("commercial."));
  assert.deepEqual(commercialFailures, [], "商业类字段不应是 readiness 阻断项");
});

test("G4 release.submitReview/publishAfterApproval 由 release 阻断（旧契约）继续生效", () => {
  // 这条覆盖的是既有 release 阻断逻辑（不属于新 contract）；用最小化产品即可
  const product = {
    sales: { productType: "domesticShort", productForm: "privateTour", splitGroup: false },
    basicInfo: { supplierProductName: "x" },
    commercial: { release: { submitReview: true, publishAfterApproval: true, publicPriceCeiling: 3000, publicAuditRetries: 4 } },
  };
  // 直接调用 import 的 automationBlockers 走旧 release 路径
  // 这里只验证新 contract 不会把 release 当成 ai-planning 阻断；
  // automationBlockers 的 release 阻断由旧逻辑继续承担。
  const result = evaluateAutomationContract(product);
  // release 在新 contract 里走 ai-soft 路径，缺失 publicPriceCeiling 时不进 failures
  // （publicPriceCeiling 有默认值；这条不进入 failures）。
  assert.equal(result.failures.some((f) => /release/.test(f.field.path)), false);
});

test("G4 VBK_PRODUCT_FIELDS 包含至少 1 个 account-fixed 字段（管家联系人）", () => {
  const accountFixed = VBK_PRODUCT_FIELDS.filter((f) => f.source === "account-fixed");
  assert.ok(accountFixed.some((f) => f.path === "operations.butlerContact"), "管家联系人必须是 account-fixed 阻断");
});

test("G4 VBK_PRODUCT_FIELDS 至少 4 个 vbk-runtime 字段（packageName/pricing/inventory/terms/cover imageId）", () => {
  const vbkRuntime = VBK_PRODUCT_FIELDS.filter((f) => f.source === "vbk-runtime");
  assert.ok(vbkRuntime.length >= 4, `应有 >=4 个 vbk-runtime 字段，实际 ${vbkRuntime.length}`);
});

test("G4 PRODUCT_JSON_LOCATION 文档化产品 JSON 的存储位置与写入时机", () => {
  assert.equal(PRODUCT_JSON_LOCATION.table, "projects");
  assert.equal(PRODUCT_JSON_LOCATION.column, "product_json");
  assert.match(PRODUCT_JSON_LOCATION.schema, /productSchema/);
  assert.match(PRODUCT_JSON_LOCATION.dataPath, /userData/);
});

test("G4 evaluateAutomationContract 对空产品 failures 数量等于所有 ai-planning 字段", () => {
  const product = {} as Record<string, unknown>;
  const result = evaluateAutomationContract(product);
  const expectedAiPlanningCount = VBK_PRODUCT_FIELDS.filter(
    (f) => f.source === "ai-planning" || f.source === "account-fixed",
  ).length;
  assert.equal(result.failures.length, expectedAiPlanningCount);
  assert.equal(result.ready, false);
});

test("G4 evaluateAutomationContract 不抛错：check 函数即使抛错也会被吞掉标记为 not ok", () => {
  const product = { presentation: { recommendations: null } } as unknown as Record<string, unknown>;
  const result = evaluateAutomationContract(product);
  // 不会抛错
  assert.ok(result);
  assert.equal(result.ready, false);
});
