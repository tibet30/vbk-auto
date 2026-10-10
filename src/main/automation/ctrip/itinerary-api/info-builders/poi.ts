/**
 * 把 project.itinerary 数组里 spots 的 poiId / name 规整为 VBK 协议的
 * tourDailyPois 元素。
 *   - spots 为空数组 → 抛错（业务要求每日至少 1 个 poiId 已验证的景点）；
 *   - 缺 poiId / poiName → 抛错（含位置信息便于排查）；
 *   - tourDailyPois 元素同步设置 orFlag / suffixName（票型按语义）。
 */

import { emptyPoiSkeleton } from "../info-skeletons.js";
import type { ProductItineraryDay } from "../itinerary-transform.js";
import { attractionTicketSuffix } from "./ticket-suffix.js";

export function buildAttractionPois(
  spots: ProductItineraryDay["spots"],
): Array<Record<string, unknown>> {
  const list = Array.isArray(spots) ? spots : [];
  if (!list.length) {
    throw new Error(`行程景点缺失：每日必须至少 1 个已验证 poiId 的景点`);
  }
  return list.map((spot, index) => {
    const poiId = typeof spot?.poiId === "number" ? spot.poiId : null;
    const poiName = spot?.poiName || spot?.name || "";
    if (!poiId || !poiName) {
      throw new Error(
        `第 ${index + 1} 个景点缺 poiId/poiName（已通过 suggestPoi 校验过的景点必须有 poiId）：${JSON.stringify(spot).slice(0, 200)}`,
      );
    }
    return {
      tourDailyPoiId: null,
      poi: {
        ...emptyPoiSkeleton(),
        ...(spot.poiData ?? {}),
        poiId,
        poiName,
        poiType: spot.poiType ?? { key: null, name: null },
        ticketType: spot.ticketType ?? null,
        currency: (spot.poiData?.currency as Record<string, unknown> | undefined) ?? {},
        costUnit: (spot.poiData?.costUnit as Record<string, unknown> | undefined) ?? { key: 1, name: "人" },
        relateSystemTicket: { key: "F", name: "否" },
        asyncValidateStatus: "success",
      },
      sort: index + 1,
      orFlag: spot.relation === "or",
      suffixName: attractionTicketSuffix(spot),
      costInclude: { key: "", name: null },
      images: [],
      refId: null,
      parentId: null,
      poiSelfFundedActivities: [],
      groupType: { key: null, name: null },
      groupSort: null,
    };
  });
}