import assert from "node:assert/strict";
import test from "node:test";
import type { AgentEvent } from "../../src/shared/contracts-agent.js";
import { agentConversationHistoryPage } from "../../src/renderer/app/views/workspace/agent-conversation-history.js";
import { groupAgentTimelineEvents } from "../../src/renderer/app/views/workspace/agent-conversation-grouping.js";

function event(index: number): AgentEvent {
  return {
    id: `event-${index}`,
    runId: "run-1",
    type: index % 2 ? "tool_call" : "tool_result",
    createdAt: "2026-09-30T00:00:00.000Z",
    content: index % 2 ? "query_poi" : "{}",
    data: index % 2
      ? { toolCallId: `call-${index}`, modelTurnId: `turn-${index}` }
      : { toolCallId: `call-${index - 1}` },
  };
}

test("对话历史按页显示最新窗口，同时保留更早记录计数", () => {
  const events = Array.from({ length: 1_916 }, (_, index) => event(index));
  const latest = agentConversationHistoryPage(events, 0, 120);
  assert.equal(latest.events.length, 120);
  assert.equal(latest.events[0]?.id, "event-1796");
  assert.equal(latest.events.at(-1)?.id, "event-1915");
  assert.equal(latest.olderEventCount, 1_796);
  assert.equal(latest.newerEventCount, 0);

  const previous = agentConversationHistoryPage(events, 1, 120);
  assert.equal(previous.events[0]?.id, "event-1676");
  assert.equal(previous.olderEventCount, 1_676);
  assert.equal(previous.newerEventCount, 120);
});

test("大历史窗口的工具批次匹配保持线性且完整", () => {
  const events = Array.from({ length: 1_916 }, (_, index) => event(index));
  const page = agentConversationHistoryPage(events, 0, 120);
  const timeline = groupAgentTimelineEvents(page.events);
  assert.equal(timeline.length, 2);
  assert.equal(timeline.at(-1)?.kind, "assistant_thread");
});

test("历史分页拒绝无效页码，仍返回最新窗口", () => {
  const events = Array.from({ length: 121 }, (_, index) => event(index));
  const page = agentConversationHistoryPage(events, Number.NaN);
  assert.equal(page.page, 0);
  assert.equal(page.events.length, 120);
  assert.equal(page.olderEventCount, 1);
  assert.equal(agentConversationHistoryPage(events, Number.POSITIVE_INFINITY).page, 0);
  assert.equal(agentConversationHistoryPage(events, 0, Number.POSITIVE_INFINITY).events.length, 120);
});
