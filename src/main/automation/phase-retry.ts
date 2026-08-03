import type { AutomationRun } from "../../shared/contracts.js";

export function preparePhaseRetry(
  previous: AutomationRun,
  phases: string[],
  retryPhase: string,
  at = new Date().toISOString(),
): AutomationRun {
  if (previous.status !== "failed") throw new Error("只有失败的自动录入任务可以单独重试。");
  const retryIndex = phases.indexOf(retryPhase);
  if (retryIndex < 0) throw new Error(`无法重试未知阶段：${retryPhase}`);
  const failed = previous.phases.find((item) => item.phase === retryPhase);
  if (failed?.status !== "failed") throw new Error(`阶段 ${retryPhase} 当前不是失败状态。`);

  return {
    ...previous,
    status: "running",
    currentPhase: retryPhase,
    phases: phases.map((phase, index) => ({
      phase,
      status: index < retryIndex && previous.phases.find((item) => item.phase === phase)?.status === "completed"
        ? "completed"
        : "pending",
    })),
    logs: [
      ...previous.logs,
      { at, message: `正在从失败阶段重试：${retryPhase}`, level: "warning" },
    ],
    screenshot: undefined,
  };
}
