import { createHash } from "node:crypto";
import type { AgentEvent, AgentSnapshot, ProductDetail, ProductWorkflowTask } from "../../shared/contracts.js";
import type {
  DiagnosticEnvironment, ProductDiagnosticIssue, ProductDiagnosticReport, ProductIssueBlocker, ProductIssueSource,
} from "../../shared/product-diagnostic-report.js";
import { redactLogString } from "../../shared/log-redaction.js";

function eventId(parts: unknown[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

function safeText(value: unknown, limit: number): string {
  return redactLogString(typeof value === "string" ? value : "").slice(0, limit);
}

function source(task?: ProductWorkflowTask, product?: ProductDetail): ProductIssueSource {
  return task?.stage === "automation" || product?.automation?.status === "failed" ? "entry" : "planning";
}

function latestPausedEvent(snapshot: AgentSnapshot): AgentEvent | undefined {
  return [...snapshot.events].reverse().find(event => event.runId === snapshot.run?.id
    && event.type === "status" && event.data?.status === "paused");
}

function blockerOf(event?: AgentEvent): ProductIssueBlocker | undefined {
  const direct = event?.data?.noProgressBlocker;
  if (["approval_precondition", "authorization_denied", "completion_blocked"].includes(String(direct))) {
    return direct as ProductIssueBlocker;
  }
  const latest = event?.data?.noProgressBlockers;
  const item = Array.isArray(latest) ? latest.at(-1) : undefined;
  return ["approval_precondition", "authorization_denied", "completion_blocked"].includes(String(item))
    ? item as ProductIssueBlocker : undefined;
}

function issueFromAutomation(product: ProductDetail): ProductDiagnosticIssue | undefined {
  const run = product.automation;
  if (!run || run.status !== "failed") return undefined;
  const phase = run.currentPhase ?? "automation";
  const recoveryReason = run.recovery?.phases[phase]?.finalError;
  const errorLog = [...run.logs].reverse().find(log => log.level === "error");
  const reason = safeText(recoveryReason ?? errorLog?.message, 2_000);
  if (!reason) return undefined;
  const occurredAt = errorLog?.at ?? run.updatedAt ?? product.updatedAt;
  return { eventId: eventId([product.id, run.id, phase, occurredAt, reason]), source: "entry",
    state: "failed", stage: safeText(phase, 120), reason, occurredAt };
}

function issueFromAgent(product: ProductDetail, snapshot?: AgentSnapshot, task?: ProductWorkflowTask): ProductDiagnosticIssue | undefined {
  const run = snapshot?.run;
  if (!snapshot || !run || ["waiting_input", "waiting_approval", "completed", "abandoned"].includes(run.status)) return undefined;
  if (snapshot.uncertainWrite) {
    const value = snapshot.uncertainWrite;
    return { eventId: eventId([product.id, value.toolCallId, value.createdAt]), source: "entry",
      state: "uncertain_write", stage: safeText(product.automation?.currentPhase ?? task?.stage ?? "automation", 120),
      reason: safeText(value.message, 2_000), occurredAt: value.createdAt };
  }
  if (run.status === "failed" && run.error) {
    return { eventId: eventId([product.id, run.id, "failed", run.updatedAt, run.error]), source: source(task, product),
      state: "failed", stage: safeText(task?.stage ?? "agent", 120), reason: safeText(run.error, 2_000), occurredAt: run.updatedAt };
  }
  if (run.status !== "paused") return undefined;
  const pause = latestPausedEvent(snapshot);
  if (!pause || pause.data?.reportIssue === false) return undefined;
  const blockerKind = blockerOf(pause);
  const reason = safeText(pause.data?.noProgressLatestReason ?? pause.content, 2_000);
  if (!reason) return undefined;
  return { eventId: eventId([product.id, pause.id]), source: source(task, product),
    state: blockerKind ? "blocked" : "paused", stage: safeText(task?.stage ?? "agent", 120), reason,
    occurredAt: pause.createdAt, ...(blockerKind ? { blockerKind } : {}) };
}

function issueFromTask(product: ProductDetail, task?: ProductWorkflowTask): ProductDiagnosticIssue | undefined {
  if (!task || !["needs_attention", "failed"].includes(task.status) || !task.error) return undefined;
  return { eventId: eventId([product.id, task.id, task.updatedAt, task.error]), source: source(task, product),
    state: task.status === "failed" ? "failed" : "blocked", stage: safeText(task.stage, 120),
    reason: safeText(task.error, 2_000), occurredAt: task.updatedAt };
}

/** Emits at most one current abnormal stop; transient failures and normal user gates are intentionally silent.
 * Tool arguments and conversation text are deliberately excluded because they may contain credentials or PII. */
export function buildProductDiagnostics(product: ProductDetail, environment: DiagnosticEnvironment,
  snapshot?: AgentSnapshot, task?: ProductWorkflowTask): ProductDiagnosticReport[] {
  const issue = issueFromAutomation(product) ?? issueFromAgent(product, snapshot, task) ?? issueFromTask(product, task);
  return issue ? [{ schemaVersion: 2, clientId: product.id, name: safeText(product.name, 255), environment, issue }] : [];
}
