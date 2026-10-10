import { runPhaseWithRecovery, type RecoveryContext, type RunPhaseOutcome } from "../recovery/recovery.js";
import { AutomationCancelledError } from "./automation.main.errors.js";

/** Child failures retain diagnostics, but an optional traffic phase is skipped rather than blocking the parent. */
export async function runDraftPhaseWithRecovery(ctx: RecoveryContext): Promise<RunPhaseOutcome> {
  if (ctx.phase !== "trafficLine") return runPhaseWithRecovery(ctx);
  try {
    const outcome = await runPhaseWithRecovery(ctx);
    if (outcome.status === "cancelled") return outcome;
    const reason = outcome.status === "needs_user" ? outcome.finalError ?? "大交通子产品未完成"
      : ctx.run.trafficLine?.failureReason;
    if (!reason) return outcome;
    recordTrafficFailure(ctx, reason);
    return { status: "needs_user", finalError: reason };
  } catch (error) {
    if (error instanceof AutomationCancelledError || ctx.shouldCancel?.()) return { status: "cancelled" };
    const finalError = error instanceof Error ? error.message : String(error);
    recordTrafficFailure(ctx, finalError);
    return { status: "needs_user", finalError };
  }
}

function recordTrafficFailure(ctx: RecoveryContext, reason: string): void {
  const phase = ctx.run.phases.find((item) => item.phase === "trafficLine");
  // Traffic children are optional for the parent product. A failed child is a
  // recorded skip, not a failed parent phase; otherwise the runner reaches
  // preflight successfully but the persisted task is still rendered blocked.
  if (phase) phase.status = "completed";
  const recovery = ctx.run.recovery?.phases?.trafficLine;
  if (recovery) recovery.state = "completed";
  ctx.run.trafficLine = { ...ctx.run.trafficLine, children: ctx.run.trafficLine?.children ?? [],
    failureReason: ctx.run.trafficLine?.failureReason || reason, verifiedAt: undefined };
  ctx.log(`大交通子产品本轮失败，已跳过并保留诊断；继续母产品预检：${reason}`, "warning");
  ctx.persist();
}
