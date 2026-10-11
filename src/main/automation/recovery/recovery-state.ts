import type { PhaseRecovery } from "../../../shared/contracts.js";
import { DEFAULT_USER_INSTRUCTION, type RecoveryContext, type RunPhaseOutcome } from "./recovery-core.js";

export function beginPhaseRecovery(ctx: RecoveryContext): PhaseRecovery {
  ctx.run.recovery ??= { phases: {} };
  const previous = ctx.run.recovery.phases[ctx.phase];
  const history = [...(previous?.attemptsHistory ?? []),
    ...(previous?.state !== "completed" ? previous?.attempts ?? [] : [])];
  const next: PhaseRecovery = { phase: ctx.phase, state: "running", attempts: [],
    ...(history.length ? { attemptsHistory: structuredClone(history) } : {}) };
  ctx.run.recovery.phases[ctx.phase] = next;
  ctx.persist();
  return next;
}

export function blockedRecovery(ctx: RecoveryContext, rec: PhaseRecovery, finalError: string,
  userInstruction = DEFAULT_USER_INSTRUCTION): RunPhaseOutcome {
  rec.state = "needs_user";
  rec.finalError = finalError;
  rec.userInstruction = userInstruction;
  ctx.persist();
  return { status: "needs_user", finalError };
}

export function cancelledRecovery(ctx: RecoveryContext, rec: PhaseRecovery): RunPhaseOutcome {
  blockedRecovery(ctx, rec, "用户中止了自动录入", "已停止，请核查当前页面后重新保存草稿。");
  ctx.log(`phase=${ctx.phase} cancelled`, "warning");
  return { status: "cancelled", finalError: rec.finalError };
}

export function completedRecovery(ctx: RecoveryContext, rec: PhaseRecovery, attempt: number): RunPhaseOutcome {
  const row = ctx.run.phases.find(item => item.phase === ctx.phase);
  if (row) row.status = "completed";
  rec.state = "completed";
  ctx.log(`phase=${ctx.phase} attempt=${attempt} resultVerified`, "info");
  ctx.persist();
  return { status: "completed" };
}
