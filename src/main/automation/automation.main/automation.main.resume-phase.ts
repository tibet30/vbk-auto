import type { AutomationRun, ProductDetail } from "../../../shared/contracts.js";
import { parseProduct } from "../schema/schema.js";
import { draftPhasesFor } from "./automation.main.phases.js";
import { preflightRepairPhase } from "./preflight-repair-phase.js";
import { canRestartPreWriteAuthorizationFailure } from "./automation.main.class/lifecycle.js";
export { canRestartPreWriteAuthorizationFailure } from "./automation.main.class/lifecycle.js";

export function interruptedAutomationResumePhase(run?: AutomationRun): string | undefined {
  if (run?.status !== "failed") return undefined;
  const phases = [run.currentPhase, ...run.phases.map((phase) => phase.phase)]
    .filter((phase): phase is string => Boolean(phase));
  return phases.find((phase) =>
    run.recovery?.phases[phase]?.finalError === "应用重启导致自动录入被中断");
}

export function failedAutomationResumePhase(run?: AutomationRun): string | undefined {
  if (run?.status !== "failed" && run?.status !== "cancelled") return undefined;
  const current = run.phases.find(item => item.phase === run.currentPhase);
  if (run.currentPhase && (current?.status === "failed"
    || run.recovery?.phases[run.currentPhase]?.state === "needs_user"
    || (run.status === "cancelled" && run.currentPhase === "preflight" && current?.status === "completed"))) {
    return run.currentPhase;
  }
  const needsUser = run.recovery
    ? Object.values(run.recovery.phases).find((phase) => phase.phase !== "trafficLine" && phase.state === "needs_user")?.phase
    : undefined;
  const failed = needsUser ?? run.phases.find((phase) => phase.phase !== "trafficLine" && phase.status === "failed")?.phase
    ?? run.phases.find(phase => phase.status === "failed")?.phase;
  if (failed) return failed;
  // Older shell failures predate phase recovery records. Route them through
  // recoverCreatedShell, which requires an ID and verifies the existing draft.
  if (run.currentPhase === "saleControl"
    && run.phases.length > 0 && run.phases.every(phase => phase.status === "pending")
    && !canRestartPreWriteAuthorizationFailure(run, undefined)) {
    return "saleControl";
  }
  return undefined;
}

/**
 * The existing preflight owns the authoritative resource readback and can fill
 * a newly restored hotel resource without replaying later completed modules.
 * Do not inject a synthetic failed phase: phase-retry rightfully rejects it.
 */
export function approvedRecoveryStartPhase(product: ProductDetail, failedPhase: string | undefined): string | undefined {
  const preflightError = product.automation?.recovery?.phases.preflight?.finalError ?? "";
  const repairPhase = failedPhase === "preflight" ? preflightRepairPhase(preflightError) : undefined;
  if (repairPhase && draftPhasesFor(parseProduct(product.product)).includes(repairPhase)) return repairPhase;
  const needsBackfilledHotel = failedPhase === "preflight"
    && /酒店资源缺少每晚.*携程候选/.test(preflightError)
    && !product.automation?.phases.some((phase) => phase.phase === "hotelResource")
    && draftPhasesFor(parseProduct(product.product)).includes("hotelResource");
  if (needsBackfilledHotel) return "hotelResource";
  if (failedPhase === "preflight" && /(?:拼小团价格库存回读不一致|价格库存只读回读不完整)/.test(preflightError)
    && draftPhasesFor(parseProduct(product.product)).includes("pricingInventory")) return "pricingInventory";
  if (failedPhase === "trafficLine" && product.automation?.phases.some((phase) => phase.phase === failedPhase)
    && product.automation.phases.find((phase) => phase.phase === failedPhase)?.status === "failed") {
    const phases = draftPhasesFor(parseProduct(product.product));
    // 交通子产品校验依赖母产品正式住宿段。历史任务可能在本地已有酒店候选，
    // 但远端住宿段仍为空；先补写 hotelResource，再回到 trafficLine，避免
    // preflight 的只读门永远先以“实际 0”阻断修复。
    if (product.productId
      && phases.includes("hotelResource")
      && product.automation.phases.some((item) => item.phase === "hotelResource")) {
      return "hotelResource";
    }
    if (product.productId && product.automation.phases.some((item) => item.phase === "preflight" && item.status === "pending")
      && phases.includes("preflight") && phases
      .filter((phase) => phase !== "trafficLine" && phase !== "preflight")
      .every((phase) => product.automation?.phases.some((item) => item.phase === phase && item.status === "completed"))) {
      return "preflight";
    }
    if (phases.includes(failedPhase)) return failedPhase;
    return phases.find((phase) => product.automation?.phases.find((item) => item.phase === phase)?.status !== "completed");
  }
  return failedPhase;
}


export function isVerifiedAutomationComplete(product: ProductDetail): boolean {
  return product.automation?.status === 'succeeded' && hasVerifiedMotherPhases(product);
}

/** Mother evidence is independent of a failed traffic execution status. */
export function hasVerifiedMotherPhases(product: ProductDetail): boolean {
  return Boolean(product.productId && product.automation
    && product.automation.phases.some(item => item.phase === "preflight" && item.status === "completed")
    && draftPhasesFor(parseProduct(product.product)).filter(phase => phase !== "trafficLine").every(phase =>
      product.automation!.phases.some(item => item.phase === phase && item.status === "completed")));
}
