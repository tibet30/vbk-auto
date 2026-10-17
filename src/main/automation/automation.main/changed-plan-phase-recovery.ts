import type { AutomationRun, ProductDetail } from "../../../shared/contracts.js";
import { completedEntryPhaseIsCurrent } from "../../application/product-entry-phase-fingerprint.js";

export function staleCompletedEntryPhases(
  product: ProductDetail,
  phases: readonly string[],
  legacyPlanChanged = false,
): string[] {
  return phases.filter((phase) => {
    const row = product.automation?.phases.find((item) => item.phase === phase);
    if (row?.status !== "completed") return false;
    const current = completedEntryPhaseIsCurrent(product, phase);
    return current === false || (current === undefined && legacyPlanChanged);
  });
}

/** Reopen only stale planning inputs; a legacy changed run is replayed conservatively. */
export function prepareChangedPlanPhaseRecovery(
  product: ProductDetail,
  phases: string[],
  retryFrom: string,
  at = new Date().toISOString(),
): AutomationRun {
  const previous = product.automation;
  if (!previous || previous.status !== "succeeded") {
    throw new Error("只有已完成的历史录入可以按规划变更恢复栏目。");
  }
  const retryIndex = phases.indexOf(retryFrom);
  if (retryIndex < 0) throw new Error(`当前产品没有变更恢复阶段：${retryFrom}`);
  const hasFingerprints = previous.phases.some((item) => Boolean(item.inputFingerprint));
  const stale = new Set(hasFingerprints
    ? staleCompletedEntryPhases(product, phases, true)
    : phases.slice(retryIndex));
  stale.add("preflight");
  return {
    ...previous,
    status: "running",
    currentPhase: retryFrom,
    phases: phases.map((phase) => {
      const prior = previous.phases.find((item) => item.phase === phase);
      return stale.has(phase)
        ? { phase, status: "pending" as const, inputFingerprint: prior?.inputFingerprint }
        : prior?.status === "completed" ? { ...prior } : { phase, status: "pending" as const };
    }),
    logs: [...previous.logs, { at, level: "warning",
      message: `当前规划已变化；重新录入栏目：${[...stale].join("、")}，其余远端回读检查点保持有效。` }],
    screenshot: undefined,
  };
}
