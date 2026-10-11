import type { AdvisorOutcome, PhaseRecovery } from "../../../shared/contracts.js";
import { buildDiagnosisHistory, isAdvisorAction, type RecoveryContext, type RunPhaseOutcome } from "./recovery-core.js";
import { blockedRecovery, cancelledRecovery } from "./recovery-state.js";

/** Validate advice before applying any action; cancellation wins over a late AI response. */
export async function advisePhaseRecovery(ctx: RecoveryContext, rec: PhaseRecovery,
  attempt: number, errorMessage: string): Promise<RunPhaseOutcome | undefined> {
  rec.state = "advising";
  ctx.persist();
  let outcome: AdvisorOutcome;
  try {
    outcome = await ctx.advisor({ phase: ctx.phase, attempt, error: errorMessage,
      productIdExists: ctx.productIdExists, basicInfoSaved: ctx.basicInfoSaved,
      completedPhases: ctx.completedPhases, diagnosisHistory: buildDiagnosisHistory(rec.attempts) });
  } catch (error) {
    if (ctx.shouldCancel?.()) return cancelledRecovery(ctx, rec);
    ctx.log(`phase=${ctx.phase} attempt=${attempt} advisorError code=${(error as { code?: string } | null)?.code ?? "advisor_failed"}`, "error");
    return blockedRecovery(ctx, rec, "AI 诊断失败");
  }
  if (ctx.shouldCancel?.()) return cancelledRecovery(ctx, rec);
  if (!outcome || !isAdvisorAction(outcome.action)
    || ![outcome.summary, outcome.rootCause, outcome.expectedEvidence].every(value => typeof value === "string" && value.trim())) {
    ctx.log(`phase=${ctx.phase} attempt=${attempt} advisorInvalidShape`, "error");
    return blockedRecovery(ctx, rec, "AI 诊断失败：模型返回不在白名单");
  }
  if (outcome.action === "wait_for_user" && (typeof outcome.userInstruction !== "string" || !outcome.userInstruction.trim())) {
    ctx.log(`phase=${ctx.phase} attempt=${attempt} advisorMissingUserInstruction`, "error");
    return blockedRecovery(ctx, rec, "AI 诊断失败：缺少可执行的用户指令");
  }
  const action = outcome.action === "reopen_editor_and_retry_phase" && !ctx.productIdExists
    ? "retry_same_phase" : outcome.action;
  const last = rec.attempts.at(-1);
  if (last) {
    last.diagnosis = { summary: outcome.summary, rootCause: outcome.rootCause, expectedEvidence: outcome.expectedEvidence };
    last.action = action;
  }
  if (action === "wait_for_user") {
    ctx.log(`phase=${ctx.phase} attempt=${attempt} waitForUser`, "warning");
    return blockedRecovery(ctx, rec, errorMessage, outcome.userInstruction);
  }
  rec.state = "retrying";
  ctx.persist();
  ctx.log(`phase=${ctx.phase} attempt=${attempt} retrying action=${action}`, "info");
  try { await ctx.applyAction(action, attempt); }
  catch {
    // The next attempt executes and verifies the phase again; a failed navigation
    // action cannot be interpreted as successful business data.
    ctx.log(`phase=${ctx.phase} attempt=${attempt} applyFailed action=${action}`, "error");
  }
  if (ctx.shouldCancel?.()) return cancelledRecovery(ctx, rec);
  return undefined;
}
