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

test("字符串脱敏：独立 Bearer、前缀拼接 Bearer、x-api-key、URL query", () => {
  for (const input of [
    "token dump = Bearer abcdefghijklmnopqrstuvwxyz",
    "Bypass header: Bearer shhhh-this-is-secret",
    "x-api-key: sk-live-1234567890abcdef",
    "POST /v1?apiKey=sk-1234567890&type=user",
    "POST /v1?signature=0123456789abcdef",
  ]) {
    const safe = redactLogString(input);
    assert.equal(safe.includes("abcdefghijklmnopqrstuvwxyz"), false, input);
    assert.equal(safe.includes("shhhh-this-is-secret"), false, input);
    assert.equal(safe.includes("sk-live-1234567890abcdef"), false, input);
    assert.equal(safe.includes("sk-1234567890"), false, input);
    assert.equal(safe.includes("0123456789abcdef"), false, input);
    assert.match(safe, /\[已脱敏\]/, input);
  }
});

test("字符串脱敏：SSH private key 原文与不带 key 头的泄露", () => {
  const ssh = "-----BEGIN OPENSSH PRIVATE KEY-----\nABCDEFG\n-----END OPENSSH PRIVATE KEY-----";
  const safe = redactLogString(ssh);
  assert.equal(safe.includes("ABCDEFG"), false);
  assert.match(safe, /\[已脱敏\]/);
  // 不带 key 头时仍能捕捉独立的 Bearer
  const naked = "stored token = Bearer 0123456789ABCDEF";
  assert.equal(redactLogString(naked).includes("0123456789ABCDEF"), false);
});

test("结构化对象：中国手机号、身份证号、VBK 业务身份随 key 一起被脱敏", () => {
  const payload = {
    phone: "13800001234",
    mobile: "+86 13900005678",
    "id-card": "11010119900101001X",
    vbkAccount: "alice@example.com",
    loginAccount: "bob@example.com",
    providerId: 1234567,
    note: "普通描述不应被触碰",
  };
  const safe = JSON.stringify(redactLogValue(payload));
  for (const secret of ["13800001234", "13900005678", "11010119900101001X", "alice@example.com", "bob@example.com", "1234567"]) {
    assert.equal(safe.includes(secret), false, secret);
  }
  assert.match(safe, /\[已脱敏\]/);
  assert.match(safe, /普通描述不应被触碰/);
});

test("结构化对象里手机 / 身份证只在 key 头存在时脱敏（避免误伤普通数字串）", () => {
  const payload = { note: "下单 13800001234 请核对", unrelated: "11010119900101001X 可能只起紧示" };
  const safe = JSON.stringify(redactLogValue(payload));
  // 有 key 头时仍应脱敏：
  const withKey = { phone: "13800001234" };
  assert.equal(JSON.stringify(redactLogValue(withKey)).includes("13800001234"), false);
  // 不带 key 时保留原始文本（避免误伤业务记录里的数字）
  assert.match(safe, /下单 13800001234/);
});

test("createRuntimeLogCapture 与 sanitizeRuntimeLogCapture 也走扩充后的规则", () => {
  const capture = createRuntimeLogCapture("error", "main", [
    "事故再发",
    { xApiKey: "sk-live-must-not-leak", loginAccount: "evil@example.com", providerId: 9999999 },
  ]);
  const text = JSON.stringify(capture);
  for (const secret of ["sk-live-must-not-leak", "evil@example.com", "9999999"]) {
    assert.equal(text.includes(secret), false, secret);
  }
  const sanitized = sanitizeRuntimeLogCapture({
    level: "error",
    source: "main",
    occurredAt: new Date().toISOString(),
    message: "Authorization: Bearer abcdefghijklmnopqrstuvwxyz x-api-key=sk-live-extra-9988",
    context: { csrf: "csrf-token-1234567890", phone: "13800001234" },
  } as never);
  for (const secret of ["abcdefghijklmnopqrstuvwxyz", "sk-live-extra-9988", "csrf-token-1234567890", "13800001234"]) {
    assert.equal(JSON.stringify(sanitized).includes(secret), false, secret);
  }
});

test("结构化对象中 accountKey / sessionKey / vbkActiveAccountKey 都被脱敏", () => {
  // vbk-browser-accounts.ts:55 logWarn(... { accountKey: key }) 的泄露面。
  // 改 SENSITIVE_KEY 名单后必须捕获 accountKey / sessionKey / vbkActiveAccountKey。
  const payload = {
    accountKey: "acc-abcdef-9876",
    sessionKey: "sess-1234567890abcdef",
    vbkActiveAccountKey: "1234567",
    accountName: "show-name-不脱敏",
  };
  const safe = JSON.stringify(redactLogValue(payload));
  for (const secret of ["acc-abcdef-9876", "sess-1234567890abcdef", "1234567"]) {
    assert.equal(safe.includes(secret), false, secret);
  }
  // accountName 不在名单，保留。
  assert.match(safe, /show-name-不脱敏/);
});

test("createRuntimeLogCapture 不会泄露 VBK 账户 key", () => {
  // 主进程 console 出口在 logSink 之外的写处（开发期 npm run dev）。
  // 这一条验证 sink 路径在 VBK 账户 key 上也安全。
  const capture = createRuntimeLogCapture("error", "main", [
    "vbk 失败", { accountKey: "acc-secret-9988", sessionKey: "sess-secret-7766" },
  ]);
  const text = JSON.stringify(capture);
  assert.equal(text.includes("acc-secret-9988"), false);
  assert.equal(text.includes("sess-secret-7766"), false);
  assert.match(text, /\[已脱敏\]/);
});

test("URL query 中多个同名 key 都能逐个脱敏（不吞后续）", () => {
  // 之前 “通用密文类字段” stop set 不含 & / ?，遇到 URL ?token=&apiKey=
  // 会整段连吃，第二个同名参数漏。错误细节 / stack 出口都必须用这条。
  const url = "https://updater.test/feed?token=secret-abc123&apiKey=sk-leak-9876";
  const safe = redactLogString(url);
  assert.equal(safe.includes("secret-abc123"), false);
  assert.equal(safe.includes("sk-leak-9876"), false);
  assert.match(safe, /token=\[已脱敏\]&apiKey=\[已脱敏\]/);
});
