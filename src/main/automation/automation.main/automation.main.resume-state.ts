import type { AutomationRun } from "../../../shared/contracts.js";
import { prepareBackfilledPhaseRecovery, preparePhaseRetry, prepareQueuedPhaseResume } from "../phase-retry.js";

export function prepareAutomationResumeRun(previous: AutomationRun, phases: string[], retryFrom: string): AutomationRun {
  if (previous.status === "queued") return prepareQueuedPhaseResume(previous, phases, retryFrom);
  const preflight = previous.phases.find(item => item.phase === "preflight");
  const error = previous.recovery?.phases.preflight?.finalError ?? "";
  if (previous.status === "failed" && retryFrom === "pricingInventory" && preflight?.status === "failed"
    && /(?:拼小团价格库存回读不一致|价格库存只读回读不完整)/.test(error)) {
    if (!phases.includes(retryFrom)) throw new Error("当前产品没有价格库存修复阶段。");
    return {...previous, status: "running", currentPhase: retryFrom, screenshot: undefined,
      phases: phases.map(phase => ({phase, status: phase === retryFrom || phase === "preflight"
        ? "pending" : previous.phases.find(item => item.phase === phase)?.status === "completed" ? "completed" : "pending"})),
      logs: [...previous.logs, {at: new Date().toISOString(), level: "warning",
        message: "价格库存预检发现缺失，仅补充不匹配日期并重新预检；其余已回读阶段保持完成。"}],
    };
  }
  if (retryFrom === "hotelResource" && previous.status === "failed"
    && !previous.phases.some(item => item.phase === retryFrom) && preflight?.status === "failed") {
    return prepareBackfilledPhaseRecovery(previous, phases, retryFrom, "preflight");
  }
  return preparePhaseRetry(previous, phases, retryFrom);
}
