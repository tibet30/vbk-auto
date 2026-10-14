import type { ProductDetail } from "../../shared/contracts.js";
import {
  ITINERARY_REVIEW_VALIDATION_ONLY_RECOVERY_MESSAGE,
  type ItineraryReviewUnlockState,
} from "../../shared/itinerary-review-unlock.js";

type Evidence = {
  productId: string;
  tourInfoId: string;
  contentDigest: string;
};

const NORMALIZED_VALIDATION_PATHS = [
  /^\$\.tourDailyDescriptions\[\d+\]\.(?:parentId|refId)$/u,
  /^\$\.tourDailyDescriptions\[\d+\]\.tourDailyInfos\[\d+\]\.(?:parentId|refId|directionType|fixedProductsOnSale|pkgDepartureDate|sightRecommend|tourDailyCar|tourDailyDinner|tourDailyDismiss|tourDailyGather|transportation)$/u,
  /^\$\.tourDailyDescriptions\[\d+\]\.tourDailyInfos\[\d+\]\.useSegmentConfig$/u,
  /^\$\.tourDailyDescriptions\[\d+\]\.tourDailyInfos\[\d+\]\.takeoff(?:End)?Time\.key$/u,
  /^\$\.tourDailyDescriptions\[\d+\]\.tourDailyInfos\[\d+\]\.tourDailyPackage(?:Gather|Dismiss)List\[\d+\]\.(?:location|poi|rangeTemplateIds)$/u,
  /^\$\.tourDailyDescriptions\[\d+\]\.tourDailyInfos\[\d+\]\.tourDailyPackage(?:Gather|Dismiss)List\[\d+\]\.(?:trainStations|airports)\[\d+\]\.(?:arriveDate|arriveTime|departureDate|departureTime|stationNo|telCode)$/u,
  /^\$\.tourDailyDescriptions\[\d+\]\.tourDailyInfos\[\d+\]\.tourDailyPois\[\d+\]\.(?:costInclude|groupType)$/u,
  /^\$\.tourDailyDescriptions\[\d+\]\.tourDailyInfos\[\d+\]\.tourDailyPois\[\d+\]\.(?:suggestPoiList|themeSelectCount)$/u,
  /^\$\.tourDailyDescriptions\[\d+\]\.tourDailyInfos\[\d+\]\.tourDailyPois\[\d+\]\.poi\.(?:childPoiIds|cost|costUnit|currency|district)(?:\.[A-Za-z_$][A-Za-z0-9_$]*|\[\d+\])*$/u,
  /^\$\.tourDailyDescriptions\[\d+\]\.tourDailyInfos\[\d+\]\.tourDailyDinner\.foodType$/u,
  /^\$\.tourDailyDescriptions\[\d+\]\.tourDailyInfos\[\d+\]\.tourDailyHotels\[\d+\]\.(?:basicRooms|cruiseCompany|hotelType|ships)$/u,
  /^\$\.tourDailyDescriptions\[\d+\]\.tourDailyInfos\[\d+\]\.tourDailyHotels\[\d+\]\.hotel\.(?:biTag|district|ggLatitude|ggLongitude)(?:\.[A-Za-z_$][A-Za-z0-9_$]*|\[\d+\])*$/u,
];

export function isValidationOnlyNormalizationMismatch(state: ItineraryReviewUnlockState | undefined): boolean {
  const mismatch = state?.digestMismatch;
  return state?.status === "uncertain"
    && Boolean(state.attemptId)
    && Array.isArray(state.requestSteps) && state.requestSteps.length === 0
    && mismatch?.step === "审核校验"
    && mismatch.beforeDigest === state.beforeDigest
    && mismatch.paths.length > 0
    && mismatch.paths.every(path => NORMALIZED_VALIDATION_PATHS.some(pattern => pattern.test(path)));
}

/** Fresh, full plan readback is required before a validation-only dispatch becomes retryable. */
export async function recoverValidationOnlyReview(args: {
  product: ProductDetail;
  previous: ItineraryReviewUnlockState | undefined;
  evidence: Evidence;
  verifyPlan: () => Promise<{ tourInfoId: string; contentDigest: string }>;
  assertCurrent: () => void;
  updatedAt: string;
}): Promise<ItineraryReviewUnlockState | undefined> {
  const { product, previous, evidence } = args;
  if (!isValidationOnlyNormalizationMismatch(previous)) return undefined;
  if (!previous || previous.localProductId !== product.id || previous.productId !== product.productId
    || previous.accountKey !== product.vbkAccount || previous.tourInfoId !== evidence.tourInfoId
    || previous.productId !== evidence.productId) return undefined;
  const planned = await args.verifyPlan();
  args.assertCurrent();
  if (planned.tourInfoId !== evidence.tourInfoId || planned.contentDigest !== evidence.contentDigest) {
    throw new Error("只读核查发现远端行程与当前确认方案不一致，仍禁止重复提交");
  }
  return {
    localProductId: previous.localProductId,
    status: "requires_review",
    attemptId: "",
    approvalId: previous.approvalId,
    agentRunId: previous.agentRunId,
    productId: previous.productId,
    accountKey: previous.accountKey,
    tourInfoId: evidence.tourInfoId,
    beforeDigest: evidence.contentDigest,
    requestSteps: [],
    message: ITINERARY_REVIEW_VALIDATION_ONLY_RECOVERY_MESSAGE,
    updatedAt: args.updatedAt,
  };
}
