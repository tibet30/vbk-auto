import assert from "node:assert/strict";
import test from "node:test";
import { sanitiseModuleValue } from "../../src/main/planning/stage-runner.js";

test("packageName 兼容提供商返回的单键等价包装", () => {
  const parsed = sanitiseModuleValue("packageName", { packageName: "北京1天0晚私家团标准套餐" });
  assert.deepEqual(parsed, { ok: true, value: "北京1天0晚私家团标准套餐" });
});

test("packageName 不接受带额外字段或错误类型的对象", () => {
  for (const value of [
    { packageName: "套餐", extra: true },
    { packageName: { text: "套餐" } },
    { name: "套餐" },
  ]) {
    const parsed = sanitiseModuleValue("packageName", value);
    assert.equal(parsed.ok, false);
  }
});
