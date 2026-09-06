import type { AgentEvent } from "../../shared/contracts.js";
import { stripAgentReasoning } from "../../shared/agent-visible-text.js";
import type { AgentModelMessage, AgentToolCall } from "./types.js";

interface TranscriptUnit {
  anchor: number;
  cost: number;
  chars: number;
  messages: AgentModelMessage[];
}

function messageChars(message: AgentModelMessage): number {
  return message.content.length + (message.toolCalls ? JSON.stringify(message.toolCalls).length : 0);
}

function unit(anchor: number, messages: AgentModelMessage[]): TranscriptUnit {
  return { anchor, cost: messages.length, chars: messages.reduce((total, message) => total + messageChars(message), 0), messages };
}

function callId(event: AgentEvent): string | undefined {
  return typeof event.data?.toolCallId === "string" ? event.data.toolCallId : undefined;
}

function modelTurnId(event: AgentEvent): string | undefined {
  return typeof event.data?.modelTurnId === "string" ? event.data.modelTurnId : undefined;
}

function toToolCall(event: AgentEvent): AgentToolCall {
  return {
    id: callId(event) ?? event.id,
    name: typeof event.data?.name === "string" ? event.data.name : event.content,
    arguments: event.data?.arguments && typeof event.data.arguments === "object"
      ? event.data.arguments as Record<string, unknown>
      : {},
    ...(typeof event.data?.rawArguments === "string" ? { rawArguments: event.data.rawArguments } : {}),
    ...(typeof event.data?.argumentError === "string" ? { argumentError: event.data.argumentError } : {}),
  };
}

/**
 * Build provider history from complete logical turns. Visible events remain in
 * wall-clock order, while a native assistant tool-call group is always followed
 * immediately by one result for every call, even if user steering arrived while
 * a tool was in flight.
 */
export function buildModelMessages(
  systemContent: string,
  events: AgentEvent[],
  maxHistoryMessages = 120,
  maxHistoryChars = 48_000,
): AgentModelMessage[] {
  const relevant = events.filter((event) => event.data?.streaming !== true && event.data?.interrupted !== true
    && (["user", "assistant", "tool_call", "tool_result"].includes(event.type)
      || (event.type === "status" && event.data?.modelFeedback === true)));
  const groups = new Map<string, { anchor: number; calls: AgentEvent[]; assistant?: AgentEvent }>();
  const callGroups = new Map<string, string>();

  for (let index = 0; index < relevant.length; index += 1) {
    const event = relevant[index]!;
    if (event.type !== "tool_call") continue;
    let key = modelTurnId(event);
    if (!key) {
      let start = index;
      while (start > 0 && relevant[start - 1]?.type === "tool_call" && !modelTurnId(relevant[start - 1]!)) start -= 1;
      key = `legacy:${start}`;
    }
    const group = groups.get(key) ?? { anchor: index, calls: [] };
    group.anchor = Math.min(group.anchor, index);
    group.calls.push(event);
    groups.set(key, group);
    const id = callId(event);
    if (id) callGroups.set(id, key);
  }

  for (let index = 0; index < relevant.length; index += 1) {
    const event = relevant[index]!;
    const key = modelTurnId(event);
    if (event.type !== "assistant" || !key || !groups.has(key)) continue;
    const group = groups.get(key)!;
    group.assistant = event;
    group.anchor = Math.min(group.anchor, index);
  }

  const results = new Map<string, AgentEvent>();
  relevant.forEach((event) => {
    const id = event.type === "tool_result" ? callId(event) : undefined;
    if (id && callGroups.has(id) && !results.has(id)) results.set(id, event);
  });

  const consumed = new Set<string>();
  const groupByAnchor = new Map<number, TranscriptUnit>();
  for (const group of groups.values()) {
    if (group.calls.some((event) => !results.has(callId(event) ?? event.id))) continue;
    const toolCalls = group.calls.map(toToolCall);
    const messages: AgentModelMessage[] = [{
      role: "assistant",
      content: stripAgentReasoning(group.assistant?.content ?? ""),
      toolCalls,
    }];
    for (const call of toolCalls) {
      const result = results.get(call.id)!;
      messages.push({ role: "tool", content: result.content, toolCallId: call.id });
      consumed.add(result.id);
    }
    group.calls.forEach((event) => consumed.add(event.id));
    if (group.assistant) consumed.add(group.assistant.id);
    groupByAnchor.set(group.anchor, unit(group.anchor, messages));
  }

  const units: TranscriptUnit[] = [];
  relevant.forEach((event, index) => {
    const group = groupByAnchor.get(index);
    if (group) units.push(group);
    if (consumed.has(event.id)) return;
    if (event.type === "status") {
      units.push(unit(index, [{ role: "system", content: `完成检查反馈：${event.content}` }]));
      return;
    }
    if (event.type !== "user" && event.type !== "assistant") return;
    const content = event.type === "assistant" ? stripAgentReasoning(event.content) : event.content;
    units.push(unit(index, [{ role: event.type, content }]));
  });
  units.sort((left, right) => left.anchor - right.anchor);

  let newestUser = -1;
  for (let index = units.length - 1; index >= 0; index -= 1) {
    if (units[index]!.messages.some((message) => message.role === "user")) { newestUser = index; break; }
  }
  const selected = new Set<number>();
  let used = 0;
  let usedChars = systemContent.length;
  if (newestUser >= 0) {
    selected.add(newestUser);
    used += units[newestUser]!.cost;
    usedChars += units[newestUser]!.chars;
  }
  for (let index = units.length - 1; index >= 0; index -= 1) {
    if (index === newestUser) continue;
    const unit = units[index]!;
    if (used + unit.cost > maxHistoryMessages || usedChars + unit.chars > maxHistoryChars) break;
    selected.add(index);
    used += unit.cost;
    usedChars += unit.chars;
  }
  return [{ role: "system", content: systemContent }, ...units.flatMap((candidate, index) => selected.has(index) ? candidate.messages : [])];
}
