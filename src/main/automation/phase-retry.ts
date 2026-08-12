/**
 * 阶段重试状态准备：
 *   - preparePhaseRetry 用于「整体跑过但失败」的 AutomationRun，从失败阶段往后清回 pending，
 *     之前的 completed 阶段保持 completed；
 *   - prepareSinglePhaseRetry 用于「运营手动 / 跨状态」重跑某个阶段，不重置后续状态，
 *     并把对应 phase 的 recovery 重置为 { attempts: [] }。
 *
 * 这两个函数只生成新的 AutomationRun，不触发实际执行；runner 负责按 plan 重新跑。
 */

import type { AutomationRun } from "../../shared/contracts.js";

/**
 * 准备「失败任务整段重跑」：要求 previous.status === "failed" 且目标阶段当前为 failed。
 * 返回新的 AutomationRun：status=running，phases 里「目标之前已完成」保留 completed，
 * 目标及之后阶段重置为 pending。
 */
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

/**
 * 「单阶段重新执行」状态准备：与 preparePhaseRetry 的区别是——
 *   - 不要求 previous.status 是 failed，succeeded / cancelled 也允许（用于运营
 *     在草稿已保存或手动停止后，重新跑某一个阶段去 review 当前页面效果）；
 *   - 不要求目标阶段状态为 failed，pending / running / completed 都允许；
 *   - 不重置后续阶段：只把目标阶段切回 pending，其他阶段保留原状态（避免
 *     后续已经完成的阶段被意外覆盖）。
 *
 * 与 preparePhaseRetry 共享相同 UI 表现：run.status 临时变 running 让
 * 「正在重新执行」状态可见；runner 完成后由 DraftAutomation 负责把
 * run.status 恢复为 previous.status（succeeded / cancelled / failed）。
 */
export function prepareSinglePhaseRetry(
  previous: AutomationRun,
  phases: string[],
  retryPhase: string,
  at = new Date().toISOString(),
): AutomationRun {
  if (previous.status === "running") throw new Error("自动录入正在进行中，不能重新执行。");
  const retryIndex = phases.indexOf(retryPhase);
  if (retryIndex < 0) throw new Error(`未知阶段：${retryPhase}`);

  return {
    ...previous,
    status: "running",
    currentPhase: retryPhase,
    phases: phases.map((phase, index) => {
      if (index === retryIndex) return { phase, status: "pending" };
      const row = previous.phases.find((item) => item.phase === phase);
      return row ?? { phase, status: "pending" };
    }),
    recovery: {
      ...(previous.recovery ?? { phases: {} }),
      phases: {
        ...(previous.recovery?.phases ?? {}),
        [retryPhase]: { phase: retryPhase, state: "running", attempts: [] },
      },
    },
    logs: [
      ...previous.logs,
      { at, message: `正在重新执行阶段：${retryPhase}`, level: "warning" },
    ],
    screenshot: undefined,
  };
}
