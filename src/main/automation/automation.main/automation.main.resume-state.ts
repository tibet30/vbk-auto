import type { AutomationRun } from "../../../shared/contracts.js";
import type { ProductWizardRecoveryPhase } from "../ctrip/product-menu-readback.js";
import { prepareBackfilledPhaseRecovery, preparePhaseRetry, prepareQueuedPhaseResume } from "../phase-retry.js";
import { preflightRepairPhase } from "./preflight-repair-phase.js";

export type WizardAdvanceOnlyPhase = "basic" | "presentation";

export interface WizardMenuRecovery {
  retryFrom: ProductWizardRecoveryPhase;
  run: AutomationRun;
  wizardAdvanceOnly: ReadonlySet<string>;
}

const WIZARD_PHASES: readonly ProductWizardRecoveryPhase[] = ["basic", "presentation", "itinerary"];

function completed(previous: AutomationRun, phase: string): boolean {
  return previous.phases.some(item => item.phase === phase && item.status === "completed");
}

/**
 * Rewinds a historical API-only run when the authoritative VBK menu still
 * proves that an earlier official wizard boundary was never advanced.
 *
 * This deliberately accepts only a fully completed historical basic/presentation
 * prefix. A partial or contradictory record is not safe to reinterpret here.
 */
export function prepareWizardMenuRecovery(
  previous: AutomationRun,
  phases: string[],
  requestedRetryFrom: string,
  remotePhase: ProductWizardRecoveryPhase | undefined,
  basicInfoSaved: boolean,
  at = new Date().toISOString(),
): WizardMenuRecovery | undefined {
  if (!remotePhase) return undefined;
  if (previous.status !== "failed" && previous.status !== "cancelled" && previous.status !== "queued") {
    throw new Error("只有失败、已取消或待继续的自动录入任务可以恢复 VBK 向导菜单。");
  }
  const requestedIndex = phases.indexOf(requestedRetryFrom);
  const remoteIndex = phases.indexOf(remotePhase);
  if (requestedIndex < 0 || remoteIndex < 0) {
    throw new Error("VBK 向导恢复的阶段顺序无效。");
  }
  if (remoteIndex >= requestedIndex) return undefined;

  const expectedPrefix = WIZARD_PHASES.slice(0, WIZARD_PHASES.indexOf(remotePhase) + 1);
  if (!basicInfoSaved || !["basic", "presentation"].every(phase => completed(previous, phase))
    || !expectedPrefix.every(phase => completed(previous, phase))) {
    throw new Error("VBK 菜单早于本地完成记录，缺少可安全复用的基本信息或图文回读证据。");
  }

  const wizardAdvanceOnly = new Set<string>(remotePhase === "basic"
    ? ["basic", "presentation"]
    : remotePhase === "presentation" ? ["presentation"] : []);
  const run: AutomationRun = {
    ...previous,
    status: "running",
    currentPhase: remotePhase,
    phases: phases.map((phase, index) => ({
      phase,
      status: index < remoteIndex && completed(previous, phase) ? "completed" : "pending",
    })),
    logs: [...previous.logs, {
      at,
      level: "warning",
      message: `远端 VBK 向导仍停在 ${remotePhase}；将从该归属阶段按官方下一步恢复，后续阶段重新执行并回读。`,
    }],
    screenshot: undefined,
  };
  return { retryFrom: remotePhase, run, wizardAdvanceOnly };
}

export function prepareAutomationResumeRun(previous: AutomationRun, phases: string[], retryFrom: string): AutomationRun {
  if (previous.status === "queued") return prepareQueuedPhaseResume(previous, phases, retryFrom);
  const menuGateError = previous.recovery?.phases.preflight?.finalError ?? "";
  if (previous.status === "failed" && retryFrom === "preflight" && /^VBK 菜单尚未解锁/u.test(menuGateError)) {
    return { ...previous, status: "running", currentPhase: "preflight", screenshot: undefined,
      phases: phases.map(phase => ({ phase, status: phase === "preflight" ? "pending" : "completed" })),
      logs: [...previous.logs, { at: new Date().toISOString(), level: "warning",
        message: "已确认此前各模块保存完成；仅重跑自动行程审核与最终菜单回读。" }],
    };
  }
  const preflight = previous.phases.find(item => item.phase === "preflight");
  const error = previous.recovery?.phases.preflight?.finalError ?? "";
  if (previous.status === "failed" && preflight?.status === "failed" && preflightRepairPhase(error) === retryFrom) {
    if (!phases.includes(retryFrom)) throw new Error("当前产品没有对应的修复阶段。");
    const reopenTraffic = retryFrom !== "terms" && phases.includes("trafficLine");
    const reopened = new Set([retryFrom, "preflight", ...(reopenTraffic ? ["trafficLine"] : []),
      ...(retryFrom === "hotelResource" && phases.includes("vehicleResource") ? ["vehicleResource"] : [])]);
    const repairMessage = retryFrom === "terms"
      ? "权威预检发现节假日违约费比例不一致，仅重跑条款维护与最终预检；保留其它已完成阶段。"
      : `权威预检发现内容不一致，恢复 ${retryFrom} 及必要的资源结算、交通回读与预检；保留其它已完成阶段。`;
    return { ...previous, status: "running", currentPhase: retryFrom, screenshot: undefined,
      phases: phases.map(phase => ({ phase, status: reopened.has(phase)
        ? "pending" : previous.phases.find(item => item.phase === phase)?.status === "completed" ? "completed" : "pending" })),
      logs: [...previous.logs, { at: new Date().toISOString(), level: "warning",
        message: repairMessage }],
    };
  }
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
