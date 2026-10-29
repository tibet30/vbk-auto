import { logInfo } from "../../../../shared/log-timestamp.js";
import { buildReadbackExpectations } from "./itinerary-transform.js";
import { DurationChangeRejectedError, verifyItineraryReadback } from "./readback.js";
import type { ApiPage, ItineraryApiResult } from "./transport.js";

/**
 * Recovery of an earlier timeout is strictly read-only, including on mismatch.
 * 只读恢复回读到旧天数只说明上次不确定的写入未生效，不能当作平台拒绝改天数：
 * 改抛普通错误（措辞避开「回读行程天数不一致」），可见失败但不触发转新建产品。
 */
export async function readExistingItineraryDraft(
  page: ApiPage, productId: string, draftId: string | number, auditId: string | number,
  expected: Parameters<typeof buildReadbackExpectations>[0],
): Promise<ItineraryApiResult> {
  const verify = await verifyItineraryReadback(page, draftId, buildReadbackExpectations(expected)).catch((error: unknown) => {
    if (!(error instanceof DurationChangeRejectedError)) throw error;
    throw new Error(`上次行程关联保存超时，只读回读显示 VBK 行程仍为 ${error.actualDays} 天（本轮期望 ${error.expectedDays} 天），`
      + "上次写入未确认生效；本次只读核对不重发保存、不转新建产品，请重新录入行程阶段。");
  });
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
    if (!/VBK 行程关联保存(?:浏览器请求|页面执行|BrowserView 执行)超时/u.test(reason)) throw error;
    logInfo("[vbk-itinerary-draft] association-timeout-readback", {
      message: "行程关联保存超时；仅继续严格版本与字段回读，不重发保存请求。",
    });
  }
}
