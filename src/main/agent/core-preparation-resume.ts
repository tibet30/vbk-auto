import type { AgentApproval, AgentSnapshot, ProductDetail } from "../../shared/contracts.js";

/** An explicit resume may only reopen local preparation that has no approved or remote work. */
export function canResumeLocalPreparation(snapshot: AgentSnapshot, hasApproval: boolean): boolean {
  const runId = snapshot.run?.id;
  return Boolean(runId) && !hasApproval && !snapshot.events.some((event) => event.runId === runId
    && event.type === "tool_result" && event.data?.remoteWrite === true);
}

/**
 * A changed local instruction must never inherit an approved recording run.
 * Automation can have reached VBK without leaving a `remoteWrite` tool result,
 * so its durable state and a live deterministic handoff are both evidence.
 */
export function mustIsolateApprovedRun(
  snapshot: AgentSnapshot,
  approval: AgentApproval | undefined,
  product: ProductDetail | undefined,
  deterministicHandoffActive: boolean,
): boolean {
  if (!snapshot.run || snapshot.uncertainWrite || !approval || approval.intentVersion !== snapshot.run.intentVersion) return false;
  if (!approval.scope.some((item) => item.startsWith("vbk.write_phase:"))) return false;
  if (deterministicHandoffActive) return true;
  const status = product?.automation?.status;
  return status === "running" || status === "failed" || status === "cancelled" || status === "succeeded";
}
