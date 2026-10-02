import assert from "node:assert/strict";
import test from "node:test";
import type { AgentEvent, AgentSnapshot } from "../../src/shared/contracts-agent.js";
import { agentDisplaySnapshot, agentHistoryPage } from "../../src/shared/agent-display.js";

const event = (index: number): AgentEvent => ({
  id: `event-${index}`,
  runId: "run-1",
  type: "tool_result",
  createdAt: "2026-09-30T00:00:00.000Z",
  content: "{}",
});

test("renderer display projection keeps full durable history out of push payload", () => {
  const snapshot: AgentSnapshot = { localProductId: "product-1", run: null, events: Array.from({ length: 1_916 }, (_, index) => event(index)) };
  const display = agentDisplaySnapshot(snapshot);
  assert.equal(display.eventCount, 1_916);
  assert.equal(display.events.length, 120);
  assert.equal(display.events[0]?.id, "event-1796");
  assert.equal(snapshot.events.length, 1_916);
  assert.equal(agentHistoryPage(snapshot.events, 15).events[0]?.id, "event-0");
});
