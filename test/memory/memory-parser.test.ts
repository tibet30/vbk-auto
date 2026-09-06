import assert from "node:assert/strict";
import test from "node:test";
import { parseExplicitMemoryIntent } from "../../src/main/memory/memory-parser.js";

test("解析明确的长期记忆请求", () => {
  const result = parseExplicitMemoryIntent("记住以后文案风格克制一些，少用夸张词");
  assert.equal(result.shouldCapture, true);
  if (!result.shouldCapture) return;
  assert.equal(result.topic, "copywriting");
  assert.equal(result.preferenceKey, "default");
  assert.match(result.content, /文案风格克制/);
  assert.deepEqual(result.conditions, ["长期偏好"]);
});

test("没有明确记忆口令时不捕获", () => {
  const result = parseExplicitMemoryIntent("这次先说说西安 4 天怎么玩");
  assert.equal(result.shouldCapture, false);
  if (result.shouldCapture) return;
  assert.equal(result.reason, "no-explicit-memory-intent");
});

test("敏感信息即使命中记忆口令也不落为长期记忆", () => {
  const result = parseExplicitMemoryIntent("记住我的密码是 123456");
  assert.equal(result.shouldCapture, false);
  if (result.shouldCapture) return;
  assert.equal(result.reason, "sensitive-memory-blocked");
});
