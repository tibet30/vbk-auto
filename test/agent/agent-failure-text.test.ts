// 智能体失败文案映射的回归：任何模型/传输故障都必须收敛成中文说明，英文 SDK 原文不许进界面。
import assert from "node:assert/strict";
import test from "node:test";
import { NoOutputGeneratedError } from "ai";
import { describeAgentFailure, toAgentFailureError } from "../../src/main/agent/agent-failure.js";
import { completeWithRetries } from "../../src/main/agent/core-model.js";
import type { AgentModel } from "../../src/main/agent/types.js";

function withStatus(status: number, message = "request failed"): Error {
  const error = new Error(message);
  Object.assign(error, { statusCode: status, name: "AI_APICallError" });
  return error;
}

test("空流 / No output generated 收敛成中文说明并保留诊断", () => {
  const error = new NoOutputGeneratedError({ message: "No output generated. Check the stream for errors." });
  const failure = describeAgentFailure(error);
  assert.match(failure.message, /没有返回任何内容/u);
  assert.doesNotMatch(failure.message, /No output generated/u);
  assert.match(failure.detail ?? "", /No output generated/u, "原始技术信息必须保留给日志");
});

test("传输与鉴权类故障各给一句可执行的中文说明", () => {
  assert.match(describeAgentFailure(withStatus(401)).message, /鉴权失败/u);
  assert.match(describeAgentFailure(withStatus(403)).message, /鉴权失败/u);
  assert.match(describeAgentFailure(withStatus(429)).message, /过于频繁/u);
  assert.match(describeAgentFailure(withStatus(503)).message, /暂时不可用/u);
  const abort = new Error("This operation was aborted");
  abort.name = "AbortError";
  assert.match(describeAgentFailure(abort).message, /超时/u);
  const reset = new Error("read ECONNRESET");
  Object.assign(reset, { code: "ECONNRESET" });
  assert.match(describeAgentFailure(reset).message, /连不上模型服务/u);
});

test("上下文超长与内容审核有各自的说明，不与网络故障混淆", () => {
  const tooLong = new Error("This model's maximum context length is 8192 tokens");
  assert.match(describeAgentFailure(tooLong).message, /上下文超出模型长度限制/u);
  const moderated = new Error('{"type":"unprocessable_entity_error","message":"input new_sensitive (1026)"}');
  assert.match(describeAgentFailure(moderated).message, /内容审核拦截/u);
});

test("已经是中文的业务错误原样保留，未知英文错误兜底成中文", () => {
  assert.deepEqual(describeAgentFailure(new Error("当前任务仍在处理中，请稍候。")), {
    message: "当前任务仍在处理中，请稍候。",
  });
  const unknown = describeAgentFailure(new Error("unexpected internal failure"));
  assert.equal(unknown.message, "任务执行失败，请重试。");
  assert.equal(unknown.detail, "unexpected internal failure");
});

test("出口包装保留错误名与状态码，供上层判定与日志使用", () => {
  const wrapped = toAgentFailureError(withStatus(429, "rate limit exceeded"));
  assert.match(wrapped.message, /过于频繁/u);
  assert.equal((wrapped as Error & { statusCode?: number }).statusCode, 429);
  assert.equal(wrapped.name, "AI_APICallError");
});

test("已经中文化的错误不会被再次包装", () => {
  const original = new Error("当前任务仍在处理中，请稍候。");
  assert.equal(toAgentFailureError(original), original);
});

test("空响应按瞬时故障自动重试，业务错误立刻失败", async () => {
  let attempts = 0;
  const flaky: AgentModel = {
    async complete() {
      attempts += 1;
      if (attempts <= 2) throw new Error("模型响应为空：未返回可用内容。");
      return { content: "已恢复", toolCalls: [] };
    },
  };
  const result = await completeWithRetries(flaky, { messages: [], tools: [] });
  assert.equal(result.content, "已恢复");
  assert.equal(attempts, 3);

  let businessAttempts = 0;
  const rejected: AgentModel = {
    async complete() {
      businessAttempts += 1;
      throw new Error("当前任务仍有待审批动作，请先批准或拒绝。");
    },
  };
  await assert.rejects(completeWithRetries(rejected, { messages: [], tools: [] }), /待审批动作/u);
  assert.equal(businessAttempts, 1);
});
