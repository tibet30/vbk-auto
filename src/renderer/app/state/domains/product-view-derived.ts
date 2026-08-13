import { useMemo } from "react";
import {
  activeAdvisorHint,
  recoveryNeedsUser,
  statusState,
  vbkStageStatusText,
} from "../../helpers";
import type { AppStateBase } from "../base";

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
  const productCompletionLabel = state.readiness.ready ? "可以录入" : `${state.readiness.issues.length} 项待处理`;
  const vbkStageStatus = vbkStageStatusText(product);
  const automationActive = product?.automation?.status === "running";
  const recoveryBlocked = product?.automation ? recoveryNeedsUser(product.automation) : null;
  const advisorHint = product?.automation ? activeAdvisorHint(product.automation) : null;
  const automationPhases = product?.automation?.phases ?? [];
  const automationRecovery = product?.automation?.recovery?.phases;
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
