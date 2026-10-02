import type { AgentDisplaySnapshot, AgentEvent, AgentHistoryPage, AgentSnapshot } from "./contracts-agent.js";

export const AGENT_EVENT_PAGE_SIZE = 120;

export function agentHistoryPage(events: AgentEvent[], requestedPage: number, pageSize = AGENT_EVENT_PAGE_SIZE): AgentHistoryPage {
  const safePageSize = Number.isFinite(pageSize)
    ? Math.min(AGENT_EVENT_PAGE_SIZE, Math.max(1, Math.floor(pageSize)))
    : AGENT_EVENT_PAGE_SIZE;
  const pageCount = Math.max(1, Math.ceil(events.length / safePageSize));
  const page = Number.isFinite(requestedPage) ? Math.min(Math.max(0, Math.floor(requestedPage)), pageCount - 1) : 0;
  const end = events.length - page * safePageSize;
  const start = Math.max(0, end - safePageSize);
  return { events: events.slice(start, end), page, pageCount, olderEventCount: start, newerEventCount: events.length - end };
}

export function agentDisplaySnapshot(snapshot: AgentSnapshot): AgentDisplaySnapshot {
  return { ...snapshot, events: agentHistoryPage(snapshot.events, 0).events, eventCount: snapshot.events.length };
}
