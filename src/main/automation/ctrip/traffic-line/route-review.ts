import { getProductBaseInfoApi } from "../basic-info/read-base.js";
import { checkTourDailyStep, fetchTourDailyDetail, fetchTourInfoId, saveTourDailyDetailStep } from "../itinerary-api/steps.js";
import { postSoa, SAVE_TOUR_INFO_URL, SOHEAD } from "../itinerary-api/transport.js";
import type { TrafficLinePage } from "./client.js";

/** 仅供用户明确授权线路匹配审核后的恢复调用；普通草稿与套餐激活不能隐式提交审核。 */
export async function submitTrafficRouteReview(
  page: TrafficLinePage,
  productId: string,
  options: { authorization: "submit-route-review"; missingFreeActivityMinutes?: number },
) {
  if (options.authorization !== "submit-route-review") throw new Error("线路匹配审核尚未获得明确授权。");
  const base = await getProductBaseInfoApi(page, productId);
  if (Number(base.baseInfo?.routeId) > 0) return readTrafficRouteReview(page, productId);
  const relation = await fetchTourInfoId(page, productId);
  if (!relation.tourInfoId) throw new Error("没有已保存的行程，不能提交线路匹配审核。");
  const detail = (await fetchTourDailyDetail(page, relation.tourInfoId)).tourInfo;
  if (!detail || !Array.isArray(detail.tourDailyDescriptions) || !detail.tourDailyDescriptions.length) {
    throw new Error("已保存行程详情为空，不能提交线路匹配审核。");
  }
  const tour = prepareRouteReviewDetail(detail, options.missingFreeActivityMinutes);
  let checkedRelation: Record<string, unknown> | undefined;
  const checked = await checkTourDailyStep(page, relation.tourInfo, JSON.stringify(tour), 3,
    "线路匹配审核前行程校验", value => { checkedRelation = value; });
  // Ack 成功不能掩盖校验服务丢失已补齐的自由活动时长。
  prepareRouteReviewDetail(checked);
  await saveTourDailyDetailStep(page, checked);
  const association = checkedRelation ?? relation.tourInfo;
  await postSoa(page, SAVE_TOUR_INFO_URL, {
    contentType: "json", head: SOHEAD, saveType: 3,
    tourInfo: { ...association, tourInfoId: checked.tourInfoId }, tourDaily: JSON.stringify(tour),
  }, "提交行程线路匹配审核", {
    referrer: `https://vbooking.ctrip.com/ivbk/vendor/tourdays?productid=${encodeURIComponent(productId)}&from=vbk`,
    headers: { "x-ctx-locale": "zh-CN", "x-input-locale": "zh-CN" },
  });
  return readTrafficRouteReview(page, productId);
}

export function prepareRouteReviewDetail(detail: Record<string, any>, missingFreeActivityMinutes?: number) {
  const tour = structuredClone(detail);
  tour.isModify = true;
  for (const day of tour.tourDailyDescriptions ?? []) {
    for (const info of day.tourDailyInfos ?? []) {
      if (Number(info.activeType?.key) !== 7 || Number(info.takeTime) > 0) continue;
      if (!Number.isInteger(missingFreeActivityMinutes) || Number(missingFreeActivityMinutes) <= 0) {
        throw new Error(`第 ${day.orderDay} 天自由活动缺少正数时长，审核未提交。`);
      }
      info.takeTime = missingFreeActivityMinutes;
    }
  }
  return tour;
}

export async function readTrafficRouteReview(page: TrafficLinePage, productId: string) {
  const [base, relation] = await Promise.all([
    getProductBaseInfoApi(page, productId), fetchTourInfoId(page, productId),
  ]);
  const routeId = Number(base.baseInfo?.routeId) || 0;
  const auditStatus = String((relation.tourInfo.auditStatus as { key?: string } | undefined)?.key ?? "");
  return { productId, routeId, routeName: String(base.baseInfo?.routeMainTitle ?? ""),
    auditStatus, tourInfoId: String(relation.tourInfoId), verified: routeId > 0 && auditStatus === "A" };
}
