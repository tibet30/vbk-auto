import assert from "node:assert/strict";
import test from "node:test";
import type { AgentEvent } from "../../src/shared/contracts-agent.js";
import { groupAgentTimelineEvents, pairMethodBatchEvents } from "../../src/renderer/app/views/workspace/agent-conversation-grouping.js";

const event = (id: string, type: AgentEvent["type"], data: Record<string, unknown> = {}, content = id): AgentEvent => ({
  id, runId: "run-1", type, createdAt: "2026-09-06T00:00:00.000Z", content, data,
});

test("同一用户询问内的 AI 与工具收成一段助手线程", () => {
  const items = groupAgentTimelineEvents([
    event("user", "user"),
    event("assistant-1", "assistant", { modelTurnId: "turn-1" }, "先查询资源"),
    event("call-a", "tool_call", { modelTurnId: "turn-1", toolCallId: "a" }, "query_poi"),
    event("call-b", "tool_call", { modelTurnId: "turn-1", toolCallId: "b" }, "query_hotel_resource"),
    event("result-a", "tool_result", { toolCallId: "a" }, "{}"),
    event("result-b", "tool_result", { toolCallId: "b" }, "{}"),
    event("assistant-2", "assistant", { modelTurnId: "turn-2" }, "再完善方案"),
    event("call-c", "tool_call", { modelTurnId: "turn-2", toolCallId: "c" }, "patch_product"),
    event("result-c", "tool_result", { toolCallId: "c" }, "{}"),
    event("assistant-3", "assistant", { modelTurnId: "turn-3" }, "方案已就绪"),
    event("status", "status"),
  ]);

  assert.deepEqual(items.map((item) => item.kind), ["event", "assistant_thread", "event"]);
  assert.equal(items[1]?.kind, "assistant_thread");
  if (items[1]?.kind !== "assistant_thread") return;
  assert.deepEqual(items[1].steps.map((step) => step.kind), ["turn", "methods", "turn", "methods", "turn"]);
  assert.equal(items[1].turns, 3);
});

test("新的用户消息会切开上一段助手线程", () => {
  const items = groupAgentTimelineEvents([
    event("user-1", "user"),
    event("assistant-1", "assistant", { modelTurnId: "turn-1" }, "第一轮"),
    event("user-2", "user"),
    event("assistant-2", "assistant", { modelTurnId: "turn-2" }, "第二轮"),
  ]);
  assert.deepEqual(items.map((item) => item.kind), ["event", "assistant_thread", "event", "assistant_thread"]);
});

test("初始运行中状态合并到第一条实际进展", () => {
  const items = groupAgentTimelineEvents([
    event("running", "status", { status: "running" }, "运行中"),
    event("usage", "status", { aiUsage: { id: "usage-1" } }, "AI 已完成一次分析"),
    event("assistant", "assistant", { modelTurnId: "turn-1" }, "继续处理"),
  ]);

  assert.equal(items.length, 1);
  assert.equal(items[0]?.kind, "assistant_thread");
  if (items[0]?.kind !== "assistant_thread") return;
  assert.equal(items[0].leadingStatus?.id, "running");
  assert.equal(items[0].steps[0]?.kind, "turn");
});

test("用户请求后的运行中状态合并到第一条实际进展", () => {
  const items = groupAgentTimelineEvents([
    event("user", "user", {}, "请读取刚创建的产品"),
    event("running", "status", { status: "running" }, "运行中"),
    event("usage", "status", { aiUsage: { id: "usage-1" } }, "AI 已完成一次分析"),
  ]);

  assert.equal(items.length, 2);
  assert.equal(items[0]?.kind, "event");
  assert.equal(items[1]?.kind, "event");
  if (items[1]?.kind !== "event") return;
  assert.equal(items[1].event.id, "running");
  assert.equal(items[1].leadingStatus, undefined);
});

test("用量记录插在调用和返回之间时，返回仍配对到原工具", () => {
  const items = groupAgentTimelineEvents([
    event("call-a", "tool_call", { modelTurnId: "turn-1", toolCallId: "a" }, "query_poi"),
    event("usage", "status", { aiUsage: { id: "usage-1" } }, "AI 已完成一次分析"),
    event("result-a", "tool_result", { toolCallId: "a" }, "poi-ok"),
  ]);

  assert.equal(items.length, 1);
  assert.equal(items[0]?.kind, "assistant_thread");
  if (items[0]?.kind !== "assistant_thread") return;
  const methods = items[0].steps[0];
  assert.equal(methods?.kind, "methods");
  if (methods?.kind !== "methods") return;
  assert.equal(pairMethodBatchEvents(methods.events)[0]?.result?.id, "result-a");
});

test("初始运行中状态合并到第一批工具摘要", () => {
  const items = groupAgentTimelineEvents([
    event("running", "status", { status: "running" }, "运行中"),
    event("call", "tool_call", { modelTurnId: "turn-1", toolCallId: "a" }, "read_product"),
    event("result", "tool_result", { toolCallId: "a" }, "{}"),
  ]);

  assert.deepEqual(items.map((item) => item.kind), ["assistant_thread"]);
  assert.equal(items[0]?.kind, "assistant_thread");
  if (items[0]?.kind !== "assistant_thread") return;
  assert.equal(items[0].leadingStatus?.id, "running");
  assert.deepEqual(items[0].steps.map((step) => step.kind), ["methods"]);
});

test("确认事件之后迟到的工具回传作为执行结果保留，不生成孤立 AI 头像", () => {
  const items = groupAgentTimelineEvents([
    event("call", "tool_call", { modelTurnId: "turn-1", toolCallId: "approval-call" }, "request_approval"),
    event("request", "approval_request", {}, "方案待确认"),
    event("approved", "approval", {}, "用户已授权"),
    event("result", "tool_result", { toolCallId: "approval-call" }, "授权已确认。"),
    event("running", "status", { status: "running" }, "运行中"),
  ]);

  assert.deepEqual(items.map((item) => item.kind), ["assistant_thread", "event", "event", "event", "event"]);
  assert.equal(items[3]?.kind, "event");
  if (items[3]?.kind !== "event") return;
  assert.equal(items[3].event.type, "tool_result");
});

test("没有批次标识的历史执行事件不被误合并", () => {
  const items = groupAgentTimelineEvents([event("call", "tool_call"), event("result", "tool_result", { toolCallId: "call" })]);
  assert.deepEqual(items.map((item) => item.kind), ["event", "event"]);
});

test("方法批次按 toolCallId 配对调用与返回", () => {
  const pairs = pairMethodBatchEvents([
    event("call-b", "tool_call", { modelTurnId: "turn-1", toolCallId: "b" }, "query_hotel_resource"),
    event("call-a", "tool_call", { modelTurnId: "turn-1", toolCallId: "a" }, "query_poi"),
    event("result-a", "tool_result", { toolCallId: "a" }, "poi-ok"),
    event("result-b", "tool_result", { toolCallId: "b" }, "hotel-ok"),
  ]);
  assert.equal(pairs.length, 2);
  assert.equal(pairs[0]?.call.content, "query_hotel_resource");
  assert.equal(pairs[0]?.result?.content, "hotel-ok");
});

test("分段历史的工具调用可从完整会话找到持久化结果", () => {
  const call = event("call", "tool_call", { modelTurnId: "turn-1", toolCallId: "a" }, "query_poi");
  const result = event("result", "tool_result", { toolCallId: "a" }, "poi-ok");
  const pairs = pairMethodBatchEvents([call], [call, result]);
  assert.equal(pairs[0]?.result?.id, "result");
});
