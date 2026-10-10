import test from "node:test";
import assert from "node:assert/strict";
import { buildPlanningMessages, classifyAssistantReply, decideRetry } from "../../src/main/minimax/minimax-planning.js";

test("classifyAssistantReply centralizes placeholder and trivial reply detection", () => {
  assert.deepEqual(classifyAssistantReply("暂不写入，等待重试"), { fallback: true, trivial: false });
  assert.deepEqual(classifyAssistantReply("ok"), { fallback: false, trivial: true });
  assert.deepEqual(classifyAssistantReply("已补齐行程"), { fallback: false, trivial: false });
});

test("planning retry helpers retain history only for an existing draft and stop at the limit", () => {
  const messages = buildPlanningMessages({ product: {}, message: "继续", history: [{ role: "assistant", content: "旧回复" }], systemPrompt: "system", hasExistingDraft: true, attempt: 1, lastRetryReason: "格式错误" });
  assert.equal(messages[1]?.role, "assistant");
  assert.match(String(messages.at(-1)?.content), /上一次返回原因：格式错误/);
  assert.equal(decideRetry("invalid_model_output", 3), true);
  assert.equal(decideRetry("invalid_model_output", 4), false);
  assert.equal(decideRetry("provider_timeout", 0), false);
});
