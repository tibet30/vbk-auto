import assert from "node:assert/strict";
import test from "node:test";
import type { AgentThreadMessage } from "../../src/shared/contracts-agent-workspace.js";
import { assembleThreadContext, buildThreadSummary } from "../../src/main/agent-workspace/context-compression.js";

function messages(count: number): AgentThreadMessage[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `m-${index}`,
    threadId: "thread-1",
    role: index % 2 ? "assistant" : "user",
    content: `第 ${index + 1} 条消息 ${"内容".repeat(20)}`,
    createdAt: new Date(2026, 0, 1, 0, 0, index).toISOString(),
  }));
}

test("短任务保留完整近期原文，不制造摘要", () => {
  const source = messages(10);
  assert.equal(buildThreadSummary(source), undefined);
  const context = assembleThreadContext({ messages: source });
  assert.equal(context.messages.length, 10);
  assert.equal(context.compressedMessageCount, 0);
});

test("长任务压缩较早消息但完整历史仍由调用方保留", () => {
  const source = messages(40);
  const summary = buildThreadSummary(source, undefined, "2026-01-01T01:00:00.000Z")!;
  assert.equal(summary.coveredMessageCount, 16);
  assert.match(summary.text, /用户|智能体/);
  const context = assembleThreadContext({ messages: source, summary });
  assert.equal(context.messages.length, 24);
  assert.equal(context.compressedMessageCount, 16);
  assert.equal(source.length, 40, "上下文压缩不能修改完整历史");
});

test("上下文组装遵守预算并至少保留最近四条", () => {
  const source = messages(40).map((message) => ({ ...message, content: "长内容".repeat(800) }));
  const summary = buildThreadSummary(source)!;
  const context = assembleThreadContext({ messages: source, summary, tokenBudget: 1_000 });
  assert.ok(context.messages.length >= 4);
  assert.ok(context.messages.length < 24);
  assert.equal("id" in context.messages[0], false, "模型上下文不能暴露存储主键");
});

