import test from "node:test";
import assert from "node:assert/strict";
import { agentPatchOperations } from "../../src/main/agent/integration-patch.js";
import { PRODUCT_PATCH_SCHEMA } from "../../src/main/agent/integration-patch-schema.js";
import { normaliseProductDraft } from "../../src/main/data/product-normalize.js";
import { applyProductPatch } from "../../src/main/operations/product-patch.js";
import type { ProductDetail } from "../../src/shared/contracts.js";

const detail = (days: unknown = 2, nights: unknown = 1) => ({
  product: { basicInfo: { days, nights }, itinerary: [] },
  messages: [],
  researchTasks: [],
} as unknown as ProductDetail);

test("patch_product schema 明确要求天数和晚数为 number", () => {
  const basicInfo = PRODUCT_PATCH_SCHEMA.properties.patch.properties.basicInfo;
  assert.equal(basicInfo.properties.days.type, "number");
  assert.equal(basicInfo.properties.nights.type, "number");
});

test("patch_product 把模型返回的合法数字字符串规范为 number", () => {
  const current = detail("2", "1");
  const patch = agentPatchOperations(current, { basicInfo: { days: "2", nights: "1" } });
  assert.deepEqual(patch, [
    { op: "replace", path: "/basicInfo/days", value: 2 },
    { op: "replace", path: "/basicInfo/nights", value: 1 },
  ]);
});

test("patch_product 拒绝越界、小数和改写已锁定晚数", () => {
  for (const patch of [
    { basicInfo: { days: 0 } },
    { basicInfo: { days: 2.5 } },
    { basicInfo: { days: "2.5" } },
    { basicInfo: { nights: -1 } },
    { basicInfo: { nights: "abc" } },
    { basicInfo: { nights: 2 } },
  ]) assert.throws(() => agentPatchOperations(detail(), patch), /天数|晚数|basicInfo/);
});

test("合法数字补丁可修复已持久化的数字字符串", () => {
  const current = detail("2", "1");
  const patch = agentPatchOperations(current, { basicInfo: { days: "2", nights: "1" } });
  const repaired = applyProductPatch(current.product, patch);
  assert.equal((repaired.basicInfo as Record<string, unknown>).days, 2);
  assert.equal((repaired.basicInfo as Record<string, unknown>).nights, 1);
});

test("草稿归一化自愈合法数字字符串，但保留非法值供 readiness 拦截", () => {
  const repaired = normaliseProductDraft({ basicInfo: { days: "2", nights: "1" } });
  assert.deepEqual(repaired.basicInfo, { days: 2, nights: 1 });

  for (const [key, value] of [["days", "2.5"], ["days", "61"], ["nights", "-1"], ["nights", "abc"]] as const) {
    const result = normaliseProductDraft({ basicInfo: { [key]: value } });
    assert.equal((result.basicInfo as Record<string, unknown>)[key], value);
  }
});
