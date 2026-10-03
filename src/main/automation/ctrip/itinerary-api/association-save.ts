import { logInfo } from "../../../../shared/log-timestamp.js";
import { buildReadbackExpectations } from "./itinerary-transform.js";
import { verifyItineraryReadback } from "./readback.js";
import type { ApiPage, ItineraryApiResult } from "./transport.js";

/** Recovery of an earlier timeout is strictly read-only, including on mismatch. */
export async function readExistingItineraryDraft(
  page: ApiPage, productId: string, draftId: string | number, auditId: string | number,
  expected: Parameters<typeof buildReadbackExpectations>[0],
): Promise<ItineraryApiResult> {
  const verify = await verifyItineraryReadback(page, draftId, buildReadbackExpectations(expected));
  const { stations } = expected;
  return {
    productId, tourInfoId: draftId, auditTourInfoId: auditId,
    days: verify.days, savedSpots: verify.spots, savedMeals: verify.meals, savedHotels: verify.hotels,
    pickupAirport: stations.pickupAir?.code ?? "", pickupTrain: stations.pickupTrain?.code ?? "",
    dropoffAirport: stations.dropoffAir?.code ?? "", dropoffTrain: stations.dropoffTrain?.code ?? "",
  };
}

/** A timeout is uncertain: perform the existing strict readback, never resend. */
export async function saveAssociationBeforeReadback(save: () => Promise<unknown>): Promise<void> {
  try {
    await save();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    if (!/VBK 行程关联保存(?:浏览器请求|页面执行)超时/u.test(reason)) throw error;
    logInfo("[vbk-itinerary-draft] association-timeout-readback", {
      message: "行程关联保存超时；仅继续严格版本与字段回读，不重发保存请求。",
    });
  }
}
