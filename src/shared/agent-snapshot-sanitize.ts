import { redactLogString, redactLogValue } from "./log-redaction.js";
import type { AgentEvent, AgentSnapshot } from "./contracts.js";

export function sanitizeAgentSnapshot(snapshot: AgentSnapshot): AgentSnapshot {
  return {
    ...snapshot,
    run: snapshot.run
      ? {
        ...snapshot.run,
        ...(snapshot.run.error ? { error: redactLogString(snapshot.run.error) } : {}),
      }
      : snapshot.run,
    events: snapshot.events.map(sanitizeAgentEvent),
    ...(snapshot.uncertainWrite
      ? {
        uncertainWrite: {
          ...snapshot.uncertainWrite,
          message: redactLogString(snapshot.uncertainWrite.message),
        },
      }
      : {}),
  };
}

function sanitizeAgentEvent(event: AgentEvent): AgentEvent {
  return {
    ...event,
    content: redactLogString(event.content),
    ...(event.data ? { data: redactLogValue(event.data) as Record<string, unknown> } : {}),
  };
}
