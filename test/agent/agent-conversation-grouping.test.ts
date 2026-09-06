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

  assert.equal(items.length, 2);
  assert.equal(items[0]?.kind, "event");
  if (items[0]?.kind !== "event") return;
  assert.equal(items[0].event.id, "usage");
  assert.equal(items[0].leadingStatus?.id, "running");
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
  assert.equal(items[1].event.id, "usage");
  assert.equal(items[1].leadingStatus?.id, "running");
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
