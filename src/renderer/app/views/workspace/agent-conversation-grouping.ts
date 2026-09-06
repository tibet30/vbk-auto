import type { AgentEvent } from "../../../../shared/contracts-agent.js";

function toolBatchId(event: AgentEvent, events: AgentEvent[]): string | undefined {
  if (event.type === "tool_call" && typeof event.data?.modelTurnId === "string") return event.data.modelTurnId;
  if (event.type !== "tool_result" || typeof event.data?.toolCallId !== "string") return undefined;
  const call = events.find((candidate) => candidate.type === "tool_call" && candidate.data?.toolCallId === event.data?.toolCallId);
  return typeof call?.data?.modelTurnId === "string" ? call.data.modelTurnId : undefined;
}

export type AgentThreadStep =
  | { kind: "turn"; event: AgentEvent }
  | { kind: "methods"; id: string; events: AgentEvent[] };

export type AgentTimelineItem =
  | { kind: "event"; event: AgentEvent; leadingStatus?: AgentEvent }
  | { kind: "assistant_thread"; id: string; steps: AgentThreadStep[]; turns: number; leadingStatus?: AgentEvent };

export type MethodBatchPair = { call: AgentEvent; result?: AgentEvent };

function closeThread(items: AgentTimelineItem[], open: (AgentTimelineItem & { kind: "assistant_thread" }) | null) {
  if (open && open.steps.length) items.push(open);
}

function isInitialRunningStatus(event: AgentEvent): boolean {
  return event.type === "status" && event.data?.status === "running" && event.content === "运行中";
}

function onlyUserEventsStarted(items: AgentTimelineItem[]): boolean {
  return items.every((item) => item.kind === "event" && item.event.type === "user" && !item.leadingStatus);
}

/** 同一用户询问内的 AI 回合与工具批次收成一段助手线程。 */
export function groupAgentTimelineEvents(events: AgentEvent[]): AgentTimelineItem[] {
  const items: AgentTimelineItem[] = [];
  let thread: (AgentTimelineItem & { kind: "assistant_thread" }) | null = null;
  let leadingStatus: AgentEvent | undefined;

  const ensureThread = (seedId: string) => {
    if (!thread) thread = { kind: "assistant_thread", id: `thread-${seedId}`, steps: [], turns: 0 };
    if (leadingStatus && !thread.leadingStatus) {
      thread.leadingStatus = leadingStatus;
      leadingStatus = undefined;
    }
    return thread;
  };

  for (const event of events) {
    if (!thread && !leadingStatus && onlyUserEventsStarted(items) && isInitialRunningStatus(event)) {
      leadingStatus = event;
      continue;
    }

    if (event.type === "assistant") {
      const current = ensureThread(event.id);
      current.steps.push({ kind: "turn", event });
      current.turns += 1;
      continue;
    }

    const batchId = toolBatchId(event, events);
    if (batchId) {
      const current = ensureThread(batchId);
      const previous = current.steps.at(-1);
      if (previous?.kind === "methods" && previous.id === batchId) previous.events.push(event);
      else current.steps.push({ kind: "methods", id: batchId, events: [event] });
      continue;
    }

    closeThread(items, thread);
    thread = null;
    items.push(leadingStatus ? { kind: "event", event, leadingStatus } : { kind: "event", event });
    leadingStatus = undefined;
  }

  closeThread(items, thread);
  if (leadingStatus) items.push({ kind: "event", event: leadingStatus });
  return items;
}

export function pairMethodBatchEvents(events: AgentEvent[]): MethodBatchPair[] {
  const results = new Map<string, AgentEvent>();
  for (const event of events) {
    if (event.type !== "tool_result" || typeof event.data?.toolCallId !== "string") continue;
    results.set(event.data.toolCallId, event);
  }
  return events.filter((event) => event.type === "tool_call").map((call) => {
    const toolCallId = typeof call.data?.toolCallId === "string" ? call.data.toolCallId : call.id;
    return { call, result: results.get(toolCallId) };
  });
}
