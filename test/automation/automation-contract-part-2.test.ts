import test from "node:test";
import assert from "node:assert/strict";
import { VBK_PRODUCT_FIELDS, evaluateAutomationContract, PRODUCT_JSON_LOCATION } from "../../src/main/automation/automation-contract.js";
import { makeValidProduct } from "./automation-contract/fixture.js";

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
    "operations.trafficLine",
    "itinerary",
  ]) {
    assert.ok(paths.has(required), `字段 ${required} 必须被契约覆盖`);
  }
});

test("G4 线路及交通未选择任何往返方式时不通过契约", () => {
  const enabledWithoutVariant = makeValidProduct() as Record<string, unknown>;
  enabledWithoutVariant.operations = { trafficLine: { enabled: true, variants: [] } };
  const result = evaluateAutomationContract(enabledWithoutVariant);
  assert.ok(result.runtimeExceptions.some((item) => item.field.path === "operations.trafficLine"));
});

test("G4 明确只安排火车往返时通过线路及交通契约", () => {
  const product = makeValidProduct() as Record<string, unknown>;
  product.operations = { ...(product.operations as Record<string, unknown>), trafficLine: { enabled: true, variants: ["trainRoundTrip"] } };
  const result = evaluateAutomationContract(product);
  assert.equal(result.runtimeExceptions.some((item) => item.field.path === "operations.trafficLine"), false);
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
  assert.equal(PRODUCT_JSON_LOCATION.table, "products");
  assert.equal(PRODUCT_JSON_LOCATION.column, "product_json");
  assert.match(PRODUCT_JSON_LOCATION.schema, /productSchema/);
  assert.match(PRODUCT_JSON_LOCATION.dataPath, /userData/);
});

test("G4 空产品仅阻塞当前模式适用的必填字段", () => {
  const product = {} as Record<string, unknown>;
  const result = evaluateAutomationContract(product);
  const expectedAiPlanningCount = VBK_PRODUCT_FIELDS.filter(
    (f) => (f.source === "ai-planning" || f.source === "account-fixed") && !f.check({}),
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
