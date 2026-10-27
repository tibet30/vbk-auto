import type { ProductDetail } from "../../../../shared/contracts.js";
import { needsTrafficLineBackfill } from "../../traffic-line-backfill.js";
import {
  approvedRecoveryStartPhase, canRestartPreWriteAuthorizationFailure, canRestartPreWriteShellFailure,
  failedAutomationResumePhase, interruptedAutomationResumePhase, isVerifiedAutomationComplete,
} from "../automation.main.resume-phase.js";
import { draftPhasesFor } from "../automation.main.phases.js";
import { parseProduct } from "../../schema/schema.js";
import { staleCompletedEntryPhases } from "../changed-plan-phase-recovery.js";

export type ApprovedWorkflowPlan =
  | { kind: "complete" }
  | { kind: "traffic-backfill" }
  | { kind: "run"; retryFrom?: string };

/** Start is a continuation unless an explicit approval requests a full replay. */
export function automationStartPhase(product: ProductDetail | undefined): string | undefined {
  const run = product?.automation;
  const interrupted = interruptedAutomationResumePhase(run);
  if (interrupted) {
    const resumable = run?.phases.some(item => item.phase === interrupted && item.status === "failed");
    if (!resumable && !(interrupted === "saleControl" && product?.productId)) {
      throw new Error("应用在销售控制创建产品壳期间退出，请先核查 VBK 是否已生成草稿，避免重复创建。");
    }
    return interrupted;
  }
  if (run?.status === "queued" && product?.productId) return run.phases.find(item => item.status === "pending")?.phase;
  if (run?.status === "failed" || run?.status === "cancelled") {
    if (canRestartPreWriteAuthorizationFailure(run, product?.productId)
      || canRestartPreWriteShellFailure(run, product?.productId)) return undefined;
    const failed = failedAutomationResumePhase(run);
    if (failed) return failed;
    if (!canRestartPreWriteAuthorizationFailure(run, product?.productId)) {
      throw new Error("当前失败记录没有可安全恢复的阶段，需先进行权威核查。");
    }
  }
  return undefined;
}

export function approvedWorkflowPlan(product: ProductDetail, replayOfAutomationRunId?: string,
  generateTrafficChildren = false, itineraryReviewPending = false,
  legacyPlanChanged = false): ApprovedWorkflowPlan {
  if (product.automation?.id && replayOfAutomationRunId === product.automation.id) return { kind: "run" };
  const hasPhaseFingerprints = product.automation?.phases.some((phase) => Boolean(phase.inputFingerprint)) === true;
  if (product.automation?.status === "succeeded" && !itineraryReviewPending
    && generateTrafficChildren && needsTrafficLineBackfill(product)
    && !hasPhaseFingerprints && !legacyPlanChanged) return { kind: "traffic-backfill" };
  if (product.automation?.status === "succeeded") {
    const phases = draftPhasesFor(parseProduct(product.product))
      .filter((phase) => phase !== "trafficLine" || generateTrafficChildren);
    const stale = staleCompletedEntryPhases(product, phases, legacyPlanChanged);
    if (stale.length) return { kind: "run", retryFrom: stale[0] };
  }
  if (itineraryReviewPending && isVerifiedAutomationComplete(product)) return { kind: "run", retryFrom: "preflight" };
  if (itineraryReviewPending && product.productId
    && /^VBK 菜单尚未解锁/u.test(product.automation?.recovery?.phases.preflight?.finalError ?? "")) {
    // Existing drafts may already have every module persisted but have stopped
    // at the final menu gate. Preflight now performs the approved unlock first.
    return { kind: "run", retryFrom: "preflight" };
  }
  if (generateTrafficChildren && needsTrafficLineBackfill(product)) return { kind: "traffic-backfill" };
  if (isVerifiedAutomationComplete(product)) return { kind: "complete" };
  if (canRestartPreWriteAuthorizationFailure(product.automation, product.productId)
    || canRestartPreWriteShellFailure(product.automation, product.productId)) return { kind: "run" };
  const queued = product.productId && product.automation?.status === "queued"
    ? product.automation.phases.find(item => item.status === "pending")?.phase : undefined;
  const retryFrom = approvedRecoveryStartPhase(product, queued ?? failedAutomationResumePhase(product.automation));
  if ((product.automation?.status === "failed" || product.automation?.status === "cancelled")
    && !retryFrom && !canRestartPreWriteAuthorizationFailure(product.automation, product.productId)
    && !canRestartPreWriteShellFailure(product.automation, product.productId)) {
    throw new Error("当前失败记录没有可安全恢复的阶段，需先进行权威核查。");
  }
  return { kind: "run", retryFrom };
}
