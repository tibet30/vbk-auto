import { persistReconciledPhase, settleReconciledDispatches } from "../../application/product-reconciled-phase.js";
import { getVbkRequestPage } from "../../infrastructure/vbk-request-page.js";
import type { MainIpcContext } from "../../ipc/context.js";
import { approvalForRun } from "../integration-gates.js";
import { reconcileAgentShell } from "../integration-reconcile.js";
import type { AgentCoreDependencies } from "../types.js";
import type { ItineraryReviewUnlockState } from "../../../shared/itinerary-review-unlock.js";
import { ITINERARY_REVIEW_VALIDATION_ONLY_RECOVERY_MESSAGE } from "../../../shared/itinerary-review-unlock.js";
import type { AgentSnapshot, ProductDetail } from "../../../shared/contracts.js";

type ReconcileUncertainWrite = NonNullable<AgentCoreDependencies["reconcileUncertainWrite"]>;

/** Only a separately persisted, plan-level readback may reopen this exact workflow run. */
function reconcileValidationOnlyItinerary(
  uncertain: { toolCallId: string; message: string },
  review: ItineraryReviewUnlockState | undefined,
  product: ProductDetail | undefined,
  snapshot: AgentSnapshot | undefined,
) {
  if (uncertain.toolCallId !== "phase:itinerary") return undefined;
  const approval = approvalForRun(snapshot);
  if (review?.status === "verified" && review.receipt?.verified === true
    && review.productId === product?.productId && review.localProductId === product?.id
    && review.accountKey === product?.vbkAccount && review.agentRunId === snapshot?.run?.id
    && review.approvalId === approval?.id && review.accountKey === approval?.accountKey
    && approval?.itineraryReviewUnlockAuthorized === true) {
    return { reconciled: true, phase: "itinerary",
      message: "已通过远端方案、审核状态和菜单边界回读确认行程审核成功。" };
  }
  if (review?.status === "requires_review" && review.attemptId === ""
    && review.message === ITINERARY_REVIEW_VALIDATION_ONLY_RECOVERY_MESSAGE
    && Array.isArray(review.requestSteps) && review.requestSteps.length === 0
    && review.digestMismatch === undefined && review.afterDigest === undefined
    && review.receipt === undefined && review.routeId === undefined
    && product?.id === review.localProductId && product.productId === review.productId
    && product.vbkAccount === review.accountKey && snapshot?.run?.id === review.agentRunId
    && approval !== undefined && approval.id === review.approvalId && approval.accountKey === review.accountKey
    && approval.itineraryReviewUnlockAuthorized === true) {
    return { reconciled: false, retryable: true,
      message: "已只读确认平台校验未改动当前方案，继续执行同一批准范围。" };
  }
  return {
    reconciled: false,
    message: "行程审核校验可能已到达 VBK，缺少完整解锁回读；不会以旧确认自动重试。",
  };
}

/** Keep uncertain-write recovery out of the Agent wiring entry point. */
export function reconcileUncertainAgentWrite(context: MainIpcContext): ReconcileUncertainWrite {
  return async (localProductId, uncertain) => context.productWorkflows.runVbkPageExclusive(async () => {
    const review = context.db.getItineraryReviewUnlockState(localProductId);
    const current = context.db.getProduct(localProductId);
    const currentSnapshot = context.db.getAgentSnapshot(localProductId);
    const itinerary = reconcileValidationOnlyItinerary(uncertain, review, current, currentSnapshot);
    if (itinerary) {
      if (itinerary.reconciled) persistReconciledPhase(context.db, localProductId, "itinerary");
      else if (itinerary.retryable) settleReconciledDispatches(context.db, localProductId, "itinerary");
      return itinerary;
    }
    if (uncertain.toolCallId === "phase:preflight" && review?.status === "uncertain"
      && (review.requestSteps?.length ?? 0) === 0
      && review.message === "远端仍未形成完整解锁证据；禁止重复提交，只能继续只读核查") {
      return { reconciled: false, retryable: true, message: "已只读确认行程审核尚未提交且远端草稿未变化，可重新执行自动校验。" };
    }
    const login = await context.browser.status(true);
    const remote = await context.remoteProducts.get(localProductId);
    const account = login.loginAccount?.trim() || login.accountName?.trim();
    if (!login.loggedIn || !account || (remote.vbkAccount && remote.vbkAccount !== account)) {
      return { reconciled: false, message: "请先登录产品绑定的 VBK 账号再核查。" };
    }
    if (!current || !currentSnapshot) return { reconciled: false, message: "产品记录不存在" };
    const result = await reconcileAgentShell(
      current, currentSnapshot, uncertain.toolCallId, await getVbkRequestPage(context.browser),
    );
    if (result.retryable && uncertain.toolCallId.startsWith("phase:")) {
      settleReconciledDispatches(context.db, localProductId, uncertain.toolCallId.slice("phase:".length));
    }
    if (result.reconciled) {
      if (result.phase) persistReconciledPhase(context.db, localProductId, result.phase);
      const fresh = context.db.getAgentSnapshot(localProductId)!;
      const event = fresh.events.find(item => item.type === "tool_result" && item.data?.toolCallId === uncertain.toolCallId);
      if (event) {
        event.data = { ...event.data, approvalId: approvalForRun(fresh)?.id, verified: true,
          phase: result.phase, productId: current.productId };
      } else {
        fresh.events.push({ id: crypto.randomUUID(), runId: fresh.run!.id, type: "tool_result",
          createdAt: new Date().toISOString(), content: result.message,
          data: { toolCallId: uncertain.toolCallId, write: true, remoteWrite: true,
            approvalId: approvalForRun(fresh)?.id, verified: true, phase: result.phase, productId: current.productId } });
      }
      context.db.saveAgentSnapshot(fresh);
    }
    return result;
  });
}
