import test from "node:test";
import assert from "node:assert/strict";
import { isModelInputModerationMessage } from "../../src/shared/ai-input-moderation.js";
import { miniMaxProviderError } from "../../src/main/minimax/minimax-runtime.js";

const config = { apiKey: "test-key", baseUrl: "https://example.invalid/v1", model: "MiniMax-M3" };

test("输入审核判定只认 provider 的 input new_sensitive 文案", () => {
  assert.equal(isModelInputModerationMessage("422 input new_sensitive (1026)"), true);
  assert.equal(isModelInputModerationMessage("input_sensitive"), true);
  assert.equal(isModelInputModerationMessage("HTTP 422: new_sensitive"), true);
  assert.equal(isModelInputModerationMessage({ error: { message: "input new_sensitive (1026)" } }), true);
  assert.equal(isModelInputModerationMessage("422 invalid params (2013)"), false);
  assert.equal(isModelInputModerationMessage("503 service unavailable"), false);
  assert.equal(isModelInputModerationMessage(undefined), false);
});

test("miniMaxProviderError 把输入审核拒绝映射为可执行的 input_moderated", () => {
  const moderation = Object.assign(new Error("422 input new_sensitive (1026)"), { status: 422 });
  const error = miniMaxProviderError(config, moderation);
  assert.equal(error.code, "input_moderated");
  assert.match(error.message, /内容审核拒绝/);
  assert.match(error.message, /更改文案/);
  assert.doesNotMatch(error.message, /无法完成本次请求/);

  // 其它失败仍走原有 provider_error，不误判成输入审核。
  assert.equal(miniMaxProviderError(config, new Error("boom")).code, "provider_error");
});
