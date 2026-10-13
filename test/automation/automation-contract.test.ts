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
} from "../../src/main/automation/automation-contract.js";
import { hasValidCoverPoMeta, hasValidPresentationRecommendations } from "../../src/main/automation/automation-contract.helpers.js";

import { makeValidProduct } from "./automation-contract/fixture.js";

test("图库地点 ID 与 VBK POI ID 不同仍按同一行程地点验证封面", () => {
  const product = makeValidProduct();
  assert.equal(hasValidCoverPoMeta(product), true);
  ((product.presentation as Record<string, unknown>).cover as Record<string, unknown>).poiId = 999999;
  assert.equal(hasValidCoverPoMeta(product), true);
  ((product.presentation as Record<string, unknown>).cover as Record<string, unknown>).poi = "不在行程的景区";
  assert.equal(hasValidCoverPoMeta(product), false);
});

test("manual upload validates saved file metadata without matching an image ID to itinerary POIs", () => {
  const product = makeValidProduct();
  (product.presentation as Record<string, unknown>).cover = {
    source: "manualUpload", fileId: "local-file", originalName: "cover.png", mimeType: "image/png",
    sizeBytes: 1024, uploadedAt: "2026-09-29T00:00:00.000Z",
    poi: "与行程无关的城市封面", description: "城市夜景", minQuality: 3,
    poiId: 999999, imageId: 888888,
  };
  assert.equal(hasValidCoverPoMeta(product), true);
  delete ((product.presentation as Record<string, unknown>).cover as Record<string, unknown>).fileId;
  assert.equal(hasValidCoverPoMeta(product), false);
});

test("仅有封面 POI 占位时不能进入 ready", () => {
  const product = makeValidProduct();
  const cover = (product.presentation as Record<string, unknown>).cover as Record<string, unknown>;
  delete cover.imageId;
  delete cover.imageUrl;
  assert.equal(hasValidCoverPoMeta(product), false);
  const result = evaluateAutomationContract(product);
  assert.equal(result.ready, false);
  assert.ok(result.failures.some((failure) => failure.field.path === "presentation.cover"));
});

test("cover POI name matching ignores empty itinerary spot names and coerces string poiId", () => {
  const product = makeValidProduct();
  const cover = (product.presentation as Record<string, unknown>).cover as Record<string, unknown>;
  const day = (product.itinerary as Array<Record<string, unknown>>)[0]!;
  const spots = day.spots as Array<Record<string, unknown>>;
  delete cover.poiId;
  cover.poi = "晋祠博物馆";
  spots[0] = { name: "", poiName: "", poiId: "" };
  assert.equal(hasValidCoverPoMeta(product), false);
  spots[0] = { name: "晋祠博物馆", poiName: "晋祠博物馆", poiId: "79413" };
  assert.equal(hasValidCoverPoMeta(product), true);
  cover.poiId = "79413";
  spots[0] = { name: "晋祠博物馆", poiName: "晋祠博物馆", poiId: "79413" };
  assert.equal(hasValidCoverPoMeta(product), true);
});

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

test("G3 assertPresentationReadyForVbk accepts complete manualUpload metadata", () => {
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
  assert.doesNotThrow(() => assertPresentationReadyForVbk(product));
});
