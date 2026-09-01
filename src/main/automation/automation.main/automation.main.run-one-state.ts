import type { AutomationRun } from "../../../shared/contracts.js";

/**
 * 单阶段重跑成功后的聚合状态。
 *
 * 修复一处阶段不应继续把整条任务标为 failed：此时已完成阶段保留，未完成
 * 阶段等待用户点击主入口继续。queued 是 TaskStatus 已有的等待态，避免把
 * 尚未跑完的草稿错误展示成「已保存」。
 */
export function resolveRunStatusAfterSinglePhaseSuccess(
  run: AutomationRun,
  originalRunStatus: AutomationRun["status"],
): AutomationRun["status"] {
  if (run.phases.length > 0 && run.phases.every((phase) => phase.status === "completed")) {
    return "succeeded";
  }

  const hasUnresolvedFailure = run.phases.some((phase) => phase.status === "failed")
    || Object.values(run.recovery?.phases ?? {}).some((recovery) => recovery.state === "needs_user");
  const hasPendingPhase = run.phases.some((phase) => phase.status === "pending");
  if (originalRunStatus === "failed" && !hasUnresolvedFailure && hasPendingPhase) {
    return "queued";
  }

  return originalRunStatus === "running" ? "running" : originalRunStatus;
}
