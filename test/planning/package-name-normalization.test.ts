import assert from "node:assert/strict";
import test from "node:test";
import { sanitiseModuleValue } from "../../src/main/planning/stage-runner.js";

test("packageName 兼容提供商返回的单键等价包装", () => {
  for (const value of [
    { packageName: "北京1天0晚私家团标准套餐" },
    { packageName: "北京1天0晚私家团标准套餐", reason: "按目的地生成" },
    { value: "北京1天0晚私家团标准套餐" },
    { name: "北京1天0晚私家团标准套餐" },
    { title: "北京1天0晚私家团标准套餐" },
  ]) {
    const parsed = sanitiseModuleValue("packageName", value);
    assert.deepEqual(parsed, { ok: true, value: "北京1天0晚私家团标准套餐" });
  }
});

test("packageName 不接受冲突字段、业务对象或错误类型", () => {
  for (const value of [
    { packageName: "套餐", extra: true },
    { packageName: "套餐", value: "另一个套餐" },
    { packageName: { text: "套餐" } },
    { currency: "CNY", adult: 1000, child: 500 },
  ]) {
    const parsed = sanitiseModuleValue("packageName", value);
    assert.equal(parsed.ok, false);
  }
});
