import { useMemo } from "react";
import {
  activeAdvisorHint,
  normalizedAutomationPhasesForDisplay,
  normalizedAutomationRecoveryForDisplay,
  recoveryNeedsUser,
  statusState,
  vbkStageStatusText,
} from "../../helpers";
import type { AppStateBase } from "../base";
import { readActiveCoverFallback } from "../../../../shared/cover-fallback.js";

/** 产品详情、核查、自动化与两步导航的纯派生视图模型。 */
export function useProductViewDerived(state: AppStateBase) {
  const { product, stage } = state;
  const itinerary = useMemo(
    () => (product && Array.isArray(product.product.itinerary)
      ? product.product.itinerary as Array<Record<string, unknown>>
      : []),
    [product],
  );
  const basic = product ? (product.product.basicInfo || {}) as Record<string, unknown> : {};
  const presentation = product ? (product.product.presentation || {}) as Record<string, unknown> : {};
  const activeTask = state.activeTaskId
    ? product?.researchTasks.find((task: { id: string }) => task.id === state.activeTaskId)
    : undefined;

  const splitStyle = product
    ? { gridTemplateColumns: stage === "review" ? "minmax(0, 1.27fr) minmax(0, 1fr)" : "minmax(0, 0.515fr) minmax(0, 1fr)" }
    : undefined;
  const coverFallback = product ? readActiveCoverFallback(product.product) : null;
  const coverHandoffReady = Boolean(coverFallback && state.readiness.ready);
  const productCompletionLabel = coverHandoffReady
    ? "可录入 VBK 草稿 · 禁止上架"
    : state.readiness.ready ? "可以录入" : `${state.readiness.issues.length} 项待处理`;
  const vbkStageStatus = vbkStageStatusText(product);
  const automationActive = product?.automation?.status === "running";
  const savedSucceeded = product?.status === "draft_saved" || product?.automation?.status === "succeeded";
  const recoveryBlocked = !savedSucceeded && product?.automation ? recoveryNeedsUser(product.automation) : null;
  const advisorHint = !savedSucceeded && product?.automation ? activeAdvisorHint(product.automation) : null;
  const automationPhases = normalizedAutomationPhasesForDisplay(product);
  const automationRecovery = normalizedAutomationRecoveryForDisplay(product, product?.automation?.recovery?.phases);
  const reviewStepStatus = !product
    ? "idle"
    : state.readiness.ready ? "passed" : state.readiness.issues.length ? "inProgress" : "reviewing";
  const vbkStepStatus = !product
    ? "idle"
    : vbkStageStatus.tone === "running" ? "inProgress"
      : vbkStageStatus.tone === "saved" ? "saved"
        : vbkStageStatus.tone === "blocked" || product.status === "blocked" || state.readiness.issues.length
          ? "blocked" : "waiting";

  return {
    itinerary, basic, presentation, activeTask,
    splitStyle, productCompletionLabel, vbkStageStatus,
    automationActive, recoveryBlocked, advisorHint, automationPhases, automationRecovery,
    saveDraftLabel: recoveryBlocked ? "重新开始一轮保存" : "保存草稿",
    reviewStepStatus, vbkStepStatus, statusState,
  };
}
