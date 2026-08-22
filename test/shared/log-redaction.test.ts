import test from "node:test";
import assert from "node:assert/strict";
import { createRuntimeLogCapture, redactLogString, redactLogValue, sanitizeRuntimeLogCapture } from "../../src/shared/log-redaction.js";

test("日志字符串脱敏 Authorization、API Key、密码、Cookie 与 URL token", () => {
  const raw = "Authorization: Bearer abc123 apiKey=sk-live password=hunter2 Cookie: sid=secret\nhttps://x.test?a=1&token=qwerty";
  const safe = redactLogString(raw);
  for (const secret of ["abc123", "sk-live", "hunter2", "sid=secret", "qwerty"]) assert.equal(safe.includes(secret), false);
  assert.match(safe, /\[已脱敏\]/);
});

test("JSON 字符串中的敏感字段也不会漏出", () => {
  const safe = redactLogString('{"apiKey":"json-key","authorization":"Bearer json-token","password":"json-password"}');
  assert.equal(safe.includes("json-key"), false);
  assert.equal(safe.includes("json-token"), false);
  assert.equal(safe.includes("json-password"), false);
});

test("结构化日志按敏感键递归脱敏并处理 Error 与循环引用", () => {
  const circular: Record<string, unknown> = { apiKey: "secret-key", nested: { password: "secret-password", ok: 7 }, error: new Error("token=secret-token") };
  circular.self = circular;
  const safe = redactLogValue(circular) as Record<string, unknown>;
  const text = JSON.stringify(safe);
  assert.equal(text.includes("secret-key"), false);
  assert.equal(text.includes("secret-password"), false);
  assert.equal(text.includes("secret-token"), false);
  assert.match(text, /循环引用/);
  assert.match(text, /\"ok\":7/);
});

test("控制台参数转换保留级别、来源、模块、消息与安全上下文", () => {
  const capture = createRuntimeLogCapture("warn", "renderer", ["2026-08-22 10:00:00.001 [planning] retry", { attempt: 2, authorization: "Bearer hidden" }]);
  assert.equal(capture.level, "warn");
  assert.equal(capture.source, "renderer");
  assert.equal(capture.module, "planning");
  assert.equal(capture.message.startsWith("[planning] retry"), true);
  assert.equal(JSON.stringify(capture.context).includes("hidden"), false);
});

test("IPC 日志输入再次脱敏且非法枚举安全降级", () => {
  const safe = sanitizeRuntimeLogCapture({
    level: "trace" as never,
    source: "unknown" as never,
    occurredAt: "invalid",
    message: "password=plain",
    context: { refreshToken: "plain-token" },
  });
  assert.equal(safe.level, "info");
  assert.equal(safe.source, "system");
  assert.equal(safe.message.includes("plain"), false);
  assert.equal(JSON.stringify(safe.context).includes("plain-token"), false);
});
