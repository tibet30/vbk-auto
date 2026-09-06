import assert from "node:assert/strict";
import test from "node:test";
import { clampRetryAfterSeconds, parseRetryAfterSeconds } from "../../src/shared/retry-after.js";

test("解析明确的重试等待秒数", () => {
  assert.equal(parseRetryAfterSeconds("请 8 秒后重试"), 8);
  assert.equal(parseRetryAfterSeconds("约 15 秒后再试"), 15);
  assert.equal(parseRetryAfterSeconds("工具失败：携程景点营业状态查询处于 WhaleGuard 风控冷却中，约 8 秒后再试"), 8);
  assert.equal(parseRetryAfterSeconds("Retry-After: 12"), 12);
  assert.equal(parseRetryAfterSeconds("8"), 8);
  assert.equal(parseRetryAfterSeconds("没有等待信息"), undefined);
});

test("等待秒数有上限保护", () => {
  assert.equal(clampRetryAfterSeconds(8), 8);
  assert.equal(clampRetryAfterSeconds(999, 120), 120);
  assert.equal(clampRetryAfterSeconds(0.2), 1);
});
