import { MAX_PHASE_ATTEMPTS, isoNow, stripSensitive, type RecoveryContext, type RunPhaseOutcome } from "./recovery-core.js";
import { AutomationCancelledError, NonAdvisableAutomationError } from "../automation.main/automation.main.errors.js";
import { beginPhaseRecovery, blockedRecovery, cancelledRecovery, completedRecovery } from "./recovery-state.js";
import { advisePhaseRecovery } from "./recovery-advisor.js";

/** Bounded attempts; only handler errors enter diagnosis, persistence errors stop the runner. */
export async function runPhaseWithRecovery(ctx: RecoveryContext): Promise<RunPhaseOutcome> {
  const now = ctx.now ?? (() => new Date());
  const rec = beginPhaseRecovery(ctx);
  let lastError = "AI 诊断失败";
  for (let attempt = 1; attempt <= MAX_PHASE_ATTEMPTS; attempt++) {
    if (ctx.shouldCancel?.()) return cancelledRecovery(ctx, rec);
    rec.state = "running";
    ctx.persist();
    let failure: { error: unknown } | undefined;
    try { await ctx.execute(); }
    catch (error) { failure = { error }; }
    if (ctx.shouldCancel?.() || failure?.error instanceof AutomationCancelledError) {
      return cancelledRecovery(ctx, rec);
    }
    if (!failure) return completedRecovery(ctx, rec, attempt);
    lastError = stripSensitive(failure.error).message;
    rec.attempts.push({ attempt, error: lastError, at: isoNow(now) });
    ctx.log(`phase=${ctx.phase} attempt=${attempt} failed`, "warning");
    ctx.persist();
    if ((failure.error as { uncertainWrite?: boolean })?.uncertainWrite) {
      blockedRecovery(ctx, rec, lastError, '平台写入结果不明，先核查当前阶段的权威回读，不能直接重复写入。');
      throw failure.error;
    }
    if (failure.error instanceof NonAdvisableAutomationError) {
      blockedRecovery(ctx, rec, lastError);
      ctx.log(`phase=${ctx.phase} nonAdvisableFailure`, "error");
      throw failure.error;
    }
    if (attempt === MAX_PHASE_ATTEMPTS) break;
    const advised = await advisePhaseRecovery(ctx, rec, attempt, lastError);
    if (advised) return advised;
  }
  ctx.log(`phase=${ctx.phase} reached max attempts ${MAX_PHASE_ATTEMPTS}, blocked`, "error");
  return blockedRecovery(ctx, rec, lastError);
}
