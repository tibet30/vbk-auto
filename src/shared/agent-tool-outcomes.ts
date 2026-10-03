import type { AgentEvent } from './contracts-agent.js';

export function failedAgentToolResult(event: AgentEvent): boolean {
  return event.type === 'tool_result' && (event.data?.error !== undefined
    || event.data?.cancelled === true || event.data?.uncertainWrite === true
    || event.data?.preparationDenied === true);
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') return Object.fromEntries(
    Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stableValue(item)]));
  return value;
}

/** A successful retry clears only the same operation, never an unrelated query. */
export function hasUnresolvedAgentToolFailure(events: AgentEvent[], runId: string): boolean {
  const calls = new Map<string, string>();
  const failures = new Set<string>();
  for (const event of events) {
    if (event.runId !== runId) continue;
    const callId = event.data?.toolCallId;
    if (event.type === 'tool_call' && typeof callId === 'string') {
      calls.set(callId, JSON.stringify([event.data?.name ?? event.content, stableValue(event.data?.arguments ?? {})]));
    }
    if (event.type === 'tool_result') {
      const key = typeof callId === 'string' ? calls.get(callId) ?? callId : event.id;
      if (failedAgentToolResult(event)) failures.add(key);
      else {
        failures.delete(key);
        // terminal results carry authoritative evidence for the whole request.
        if (event.data?.terminal === true) failures.clear();
      }
    }
    if (event.type === 'status' && event.data?.deterministicWorkflow === true
      && /最终回读/.test(event.content)) failures.clear();
    if (event.type === 'status' && event.data?.status === 'completed'
      && event.data?.completionVerified === true) failures.clear();
    if (event.type === 'status' && event.data?.reconciled === true && typeof callId === 'string') {
      failures.delete(calls.get(callId) ?? callId);
    }
  }
  return failures.size > 0;
}

export const UNRESOLVED_TOOL_SUMMARY = '仍有工具操作失败、未执行或结果不确定，尚不能确认本次请求的结果。请处理后继续核验。';
