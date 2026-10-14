import type { ProductDetail } from "../../shared/contracts.js";
import {
  itineraryReviewDigestMismatchFromError,
  type ItineraryReviewUnlockReceipt,
  type ItineraryReviewUnlockState,
} from "../../shared/itinerary-review-unlock.js";

export function uncertainItineraryReviewState(
  state: ItineraryReviewUnlockState,
  error: unknown,
  updatedAt: string,
): ItineraryReviewUnlockState {
  const digestMismatch = itineraryReviewDigestMismatchFromError(error);
  return {
    ...state,
    status: "uncertain",
    ...(digestMismatch ? { digestMismatch } : {}),
    message: error instanceof Error ? error.message : String(error),
    updatedAt,
  };
}

export function verifiedItineraryReviewState(
  product: ProductDetail,
  previous: ItineraryReviewUnlockState | undefined,
  attemptId: string,
  receipt: ItineraryReviewUnlockReceipt,
  updatedAt: string,
): ItineraryReviewUnlockState {
  const workflowBinding = previous?.productId === receipt.productId
    && previous.tourInfoId === receipt.tourInfoId
    && previous.beforeDigest === receipt.beforeDigest
    ? { approvalId: previous.approvalId, agentRunId: previous.agentRunId } : {};
  return {
    ...workflowBinding,
    localProductId: product.id,
    status: "verified",
    attemptId,
    productId: receipt.productId,
    accountKey: product.vbkAccount!,
    tourInfoId: receipt.tourInfoId,
    beforeDigest: receipt.beforeDigest,
    afterDigest: receipt.afterDigest,
    routeId: receipt.routeId,
    receipt,
    requestSteps: receipt.requestSteps,
    updatedAt,
  };
}
