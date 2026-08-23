import assert from "node:assert/strict";
import test from "node:test";
import { parseCompletionUsage, timedCompletion } from "../../src/main/ai/completion-usage.js";

test("parseCompletionUsage 读取 OpenAI 标准 prompt/completion/total", () => {
  const usage = parseCompletionUsage({
    usage: { prompt_tokens: 120, completion_tokens: 45, total_tokens: 165 },
  });
  assert.deepEqual(usage, {
    inputTokens: 120,
    outputTokens: 45,
    totalTokens: 165,
    cachedTokens: null,
    reasoningTokens: null,
  });
});

test("parseCompletionUsage 兼容 input_tokens / output_tokens 别名", () => {
  const usage = parseCompletionUsage({
    usage: { input_tokens: 10, output_tokens: 7 },
  });
  assert.equal(usage.inputTokens, 10);
  assert.equal(usage.outputTokens, 7);
  assert.equal(usage.totalTokens, 17);
});

test("parseCompletionUsage 读取 cached 与 reasoning 细分字段", () => {
  const usage = parseCompletionUsage({
    usage: {
      prompt_tokens: 100,
      completion_tokens: 50,
      total_tokens: 150,
      prompt_tokens_details: { cached_tokens: 20 },
      completion_tokens_details: { reasoning_tokens: 8 },
    },
  });
  assert.equal(usage.cachedTokens, 20);
  assert.equal(usage.reasoningTokens, 8);
});

test("parseCompletionUsage 缺 usage 或非对象时全部为 null", () => {
  assert.deepEqual(parseCompletionUsage({}), {
    inputTokens: null,
    outputTokens: null,
    totalTokens: null,
    cachedTokens: null,
    reasoningTokens: null,
  });
  assert.deepEqual(parseCompletionUsage(null), {
    inputTokens: null,
    outputTokens: null,
    totalTokens: null,
    cachedTokens: null,
    reasoningTokens: null,
  });
  assert.deepEqual(parseCompletionUsage("x"), {
    inputTokens: null,
    outputTokens: null,
    totalTokens: null,
    cachedTokens: null,
    reasoningTokens: null,
  });
});

test("timedCompletion 成功时回调 duration 与 value", async () => {
  const calls: Array<{ durationMs: number; value?: string; error?: unknown }> = [];
  const result = await timedCompletion(async () => {
    await new Promise((r) => setTimeout(r, 5));
    return "ok";
  }, (entry) => { calls.push(entry); });
  assert.equal(result, "ok");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].value, "ok");
  assert.equal(calls[0].error, undefined);
  assert.ok(calls[0].durationMs >= 0);
});

test("timedCompletion 抛错时仍回调并重新抛出", async () => {
  const calls: Array<{ durationMs: number; value?: unknown; error?: unknown }> = [];
  await assert.rejects(
    () => timedCompletion(async () => { throw new Error("boom"); }, (entry) => { calls.push(entry); }),
    /boom/,
  );
  assert.equal(calls.length, 1);
  assert.ok(calls[0].error instanceof Error);
  assert.equal((calls[0].error as Error).message, "boom");
});

test("timedCompletion 回调自己抛错不影响原结果", async () => {
  const result = await timedCompletion(
    async () => "kept",
    () => { throw new Error("recorder failed"); },
  );
  assert.equal(result, "kept");
});
