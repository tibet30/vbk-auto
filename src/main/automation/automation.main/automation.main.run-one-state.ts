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

/**
 * preflight 是母产品模块的权威只读验收。它成功时，早期迁移或中断遗留的
 * pending 标记不能再驱动旧阶段重跑；否则会把已验收的图文、行程等再次写入。
 *
 * 交通子产品不在母产品 preflight 范围内：未完成的 trafficLine 必须保留，
 * 不能因母产品预检通过而被误标为 completed。
 */
export function settleRunAfterVerifiedPreflight(run: AutomationRun): AutomationRun {
  const phases = run.phases.map((phase) => {
    if (phase.phase === "trafficLine" && phase.status !== "completed") return phase;
    return { ...phase, status: "completed" as const };
  });
  const incompleteTrafficLine = phases.find(
    (phase) => phase.phase === "trafficLine" && phase.status !== "completed",
  );
  return {
    ...run,
    status: incompleteTrafficLine ? "queued" : "succeeded",
    currentPhase: incompleteTrafficLine ? "trafficLine" : undefined,
    phases,
    recovery: run.recovery ? {
      ...run.recovery,
      phases: Object.fromEntries(Object.entries(run.recovery.phases).map(([phase, recovery]) => [
        phase,
        phase === "trafficLine" && recovery.state !== "completed"
          ? recovery
          : { ...recovery, state: "completed" as const },
      ])),
    } : undefined,
  };
}
