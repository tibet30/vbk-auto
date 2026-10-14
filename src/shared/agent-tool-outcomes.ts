import type { AgentEvent, AgentStage } from './contracts-agent.js';

export function failedAgentToolResult(event: AgentEvent): boolean {
  return event.type === 'tool_result' && (event.data?.error !== undefined
    || event.data?.cancelled === true || event.data?.uncertainWrite === true
    || event.data?.preparationDenied === true || event.data?.executionRejected === true
    || typeof event.data?.noProgressBlocker === 'string');
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') return Object.fromEntries(
    Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stableValue(item)]));
  return value;
}

function supersededStages(stages: readonly AgentStage[], runId: string): ReadonlySet<string> {
  return new Set(stages.filter((stage) => stage.runId === runId && stage.status === 'superseded')
    .map((stage) => stage.id));
}

/**
 * An interrupted call with no dispatch record is persisted as cancelled/recovered.
 * Once its whole stage is replaced, it is no longer a pending operation for the
 * new request. Do not extend this exception to errors or uncertain writes.
 */
function supersededUndispatchedCancellation(
  event: AgentEvent,
  stages: ReadonlySet<string>,
  dispatched: ReadonlySet<string>,
): boolean {
  const stageId = event.data?.stageId;
  const callId = event.data?.toolCallId;
  return event.data?.cancelled === true && event.data?.recovered === true
    && typeof stageId === 'string' && stages.has(stageId)
    && typeof callId === 'string' && !dispatched.has(callId);
}

/** A successful retry clears only the same operation, never an unrelated query. */
export function hasUnresolvedAgentToolFailure(
  events: AgentEvent[],
  runId: string,
  stages: readonly AgentStage[] = [],
): boolean {
  const calls = new Map<string, string>();
  const names = new Map<string, string>();
  const failures = new Set<string>();
  const rejected = new Set<string>();
  const superseded = supersededStages(stages, runId);
  const dispatched = new Set(events.filter((event) => event.runId === runId
    && event.data?.writeDispatch === true && typeof event.data.toolCallId === 'string')
    .map((event) => event.data!.toolCallId as string));
  for (const event of events) {
    if (event.runId !== runId) continue;
    const callId = event.data?.toolCallId;
    if (event.type === 'tool_call' && typeof callId === 'string') {
      names.set(callId, String(event.data?.name ?? event.content));
      calls.set(callId, JSON.stringify([event.data?.name ?? event.content, stableValue(event.data?.arguments ?? {})]));
    }
    if (event.type === 'tool_result') {
      if (supersededUndispatchedCancellation(event, superseded, dispatched)) continue;
      const key = typeof callId === 'string' ? calls.get(callId) ?? callId : event.id;
      const name = typeof callId === 'string' ? names.get(callId) ?? key : key;
      if (failedAgentToolResult(event)) {
        // Rejected calls never reached execution. A corrected call of the same
        // tool may use different arguments; actual failures stay target-bound.
        if (event.data?.executionRejected === true && typeof event.data?.noProgressBlocker !== 'string') rejected.add(name);
        else failures.add(key);
      }
      else {
        failures.delete(key);
        rejected.delete(name);
        // terminal results carry authoritative evidence for the whole request.
        if (event.data?.terminal === true) { failures.clear(); rejected.clear(); }
      }
    }
    if (event.type === 'status' && event.data?.deterministicWorkflow === true
      && /最终回读/.test(event.content)) { failures.clear(); rejected.clear(); }
    if (event.type === 'status' && event.data?.status === 'completed'
      && event.data?.completionVerified === true) { failures.clear(); rejected.clear(); }
    if (event.type === 'status' && event.data?.reconciled === true && typeof callId === 'string') {
      failures.delete(calls.get(callId) ?? callId);
      rejected.delete(names.get(callId) ?? callId);
    }
  }
  return failures.size > 0 || rejected.size > 0;
}

export const UNRESOLVED_TOOL_SUMMARY = '仍有工具操作失败、未执行或结果不确定，尚不能确认本次请求的结果。请处理后继续核验。';
