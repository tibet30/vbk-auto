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

/**
 * 模型用量是一次调用的旁路记录，可能在同一轮的 tool_call 与 tool_result
 * 之间异步抵达。它不能切开工具批次，否则已持久化的返回会失去原调用，
 * 页面便会永远显示「执行中」和 0/N。
 */
function isUsageStatus(event: AgentEvent): boolean {
  return event.type === "status" && event.data?.aiUsage !== undefined;
}

function onlyUserEventsStarted(items: AgentTimelineItem[]): boolean {
  return items.every((item) => item.kind === "event" && item.event.type === "user" && !item.leadingStatus);
}

function hasOpenMethodBatch(thread: { steps: AgentThreadStep[] } | null, batchId: string | undefined): boolean {
  return Boolean(batchId && thread?.steps.some((step) => step.kind === "methods" && step.id === batchId));
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
    if (isUsageStatus(event)) continue;
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
    const hasOpenBatch = hasOpenMethodBatch(thread, batchId);
    // 审批、提问等语义事件会结束上一段助手线程。之后才迟到的 tool_result
    // 不能跨过这些事件重新拼回旧批次，否则只会渲染出孤立的 AI 头像；应保留为可读的执行结果记录。
    if (event.type === "tool_result" && batchId && !hasOpenBatch) {
      closeThread(items, thread);
      thread = null;
      items.push(leadingStatus ? { kind: "event", event, leadingStatus } : { kind: "event", event });
      leadingStatus = undefined;
      continue;
    }
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

export function pairMethodBatchEvents(events: AgentEvent[], resultEvents: AgentEvent[] = events): MethodBatchPair[] {
  const results = new Map<string, AgentEvent>();
  for (const event of resultEvents) {
    if (event.type !== "tool_result" || typeof event.data?.toolCallId !== "string") continue;
    results.set(event.data.toolCallId, event);
  }
  return events.filter((event) => event.type === "tool_call").map((call) => {
    const toolCallId = typeof call.data?.toolCallId === "string" ? call.data.toolCallId : call.id;
    return { call, result: results.get(toolCallId) };
  });
}
