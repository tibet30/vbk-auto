import assert from "node:assert/strict";
import test from "node:test";
import { AI_WRITABLE_PATHS, isAiWritablePatchPath } from "../../src/shared/ai-writable-paths.js";
import { applyProductPatch, applyProductPatchSafe } from "../../src/main/operations/product-patch.js";

test("规划白名单覆盖模块根路径及其子路径", () => {
  assert.equal(isAiWritablePatchPath(AI_WRITABLE_PATHS.basicInfo), true);
  assert.equal(isAiWritablePatchPath("/basicInfo/subtitle"), true);
  assert.equal(isAiWritablePatchPath("/itinerary/0/spots/0/name"), true);
  assert.equal(isAiWritablePatchPath("/operations/trafficLine/arrivalCity"), true);
  assert.equal(isAiWritablePatchPath("/commercial/packageName"), true);
  assert.equal(isAiWritablePatchPath("/commercial/pricing/adult"), true);
});

test("白名单外路径一律拒绝，避免和 basicInfo 前缀误匹配", () => {
  assert.equal(isAiWritablePatchPath("/messages"), false);
  assert.equal(isAiWritablePatchPath("/automation"), false);
  assert.equal(isAiWritablePatchPath("/basicInfoExtra"), false);
  assert.equal(isAiWritablePatchPath("/commercial"), false);
});

test("applyProductPatch 拒绝白名单外路径", () => {
  assert.throws(
    () => applyProductPatch({ basicInfo: {} }, [{ op: "replace", path: "/messages", value: [] }]),
    /不在 AI 可写路径/,
  );
});

test("applyProductPatchSafe 跳过白名单外路径并保留合法写入", () => {
  const result = applyProductPatchSafe({ basicInfo: { subtitle: "旧" } }, [
    { op: "replace", path: "/messages", value: [{ role: "user" }] },
    { op: "replace", path: "/basicInfo/subtitle", value: "新" },
  ]);
  assert.equal(result.applied, true);
  assert.equal((result.product.basicInfo as { subtitle: string }).subtitle, "新");
  assert.equal("messages" in result.product, false);
});
