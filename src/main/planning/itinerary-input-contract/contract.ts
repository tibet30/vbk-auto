/**
 * itinerary-input-contract 主校验入口：
 *   - itineraryInputContractError：nextItinerary 改写 / patch 时给出违规原因；
 *      覆盖 days / numbered route / dated route / explicit alternative group /
 *     complete / partial 各种模式锁定；
 *   - planningWriteContractError：write*() 入口，按 module 分发：
 *       itinerary → itineraryInputContractError；
 *       basicInfo / skeleton / operations → days / meetingCity / destinationCity /
 *         transport / hotelTier 锁定校验。
 *
 * 错误信息必含"第 N 天 / 字段 / 期望 / 实际"或锁定的具体值，方便定位。
 *
 * POI 豁免链（任一可信证据命中即可从必保留集合移除）：
 *   辅助接送/住宿 → 已持久化路线节点 → 行政地点 → 运营人工 free/other 分类 → 运营人工删除。
 */

import type { ProductDetail } from "../../../shared/contracts.js";
import { extractLockedConstraints } from "../../agent/prompt-helpers.js";
import { normaliseHotelTier } from "../../../shared/hotel-tiers.js";
import { requiresItineraryPoi } from "../../../shared/itinerary-activity-kind.js";
import { numberedRouteConstraintError } from "../numbered-route-constraints.js";
import { datedRouteDetailError } from "../dated-route-projection.js";
import { hasCompletePoi } from "../../../shared/itinerary-activity-kind.js";
import {
  explicitAlternativeGroupError,
  hasTrustedOperatorAlternativeDeletion,
  hasTrustedOperatorAlternativeDeletionOnAnyDay,
} from "./alternative.js";
import {
  isNameSubsequence,
  missingNames,
  extraNames,
  asDayList,
  asRecord,
  hasTrustedOperatorNonPoiClassification,
  isDeletableAdministrativeLocation,
  isSupportingLockedSpot,
  requiresLockedAttraction,
  samePlace,
  shortCity,
  spotName,
  spotNames,
  text,
  userMessages,
} from "./utils.js";
import { classifyItineraryInputMode } from "./mode.js";
import { isPersistedRouteTravelNode } from "../../../shared/itinerary-route-travel-node.js";
import { originalOvernightRoute } from "../../../shared/original-itinerary-route.js";
import { orderedItineraryRoutePath } from "../../../shared/itinerary-route-path.js";
import { anchorKey, isLikelyAttractionAnchor, isRouteArrivalNode, splitProjectedSpots } from "../itinerary-spot-projection.js";

export function itineraryInputContractError(product: ProductDetail, nextItinerary: unknown): string | undefined {
  const locked = extractLockedConstraints(product, userMessages(product));
  const days = locked.days ?? 0;
  const mode = classifyItineraryInputMode(locked, days, product.planning?.userIntent);
  const itinerary = asDayList(nextItinerary);
  if (!itinerary) return "行程必须是逐日列表。";
  if (days > 0 && itinerary.length !== days) {
    return `行程天数必须保持为已锁定的 ${days} 天，不能改成 ${itinerary.length} 天。`;
  }
  const numberedError = numberedRouteConstraintError(product, itinerary);
  if (numberedError) return numberedError;
  const datedError = datedRouteDetailError(product, itinerary);
  if (datedError) return datedError;
  const alternativeError = explicitAlternativeGroupError(product, itinerary);
  if (alternativeError) return alternativeError;
  if (mode === "open") return undefined;

  const byDay = new Map(itinerary.map((day) => [Number(day.day), spotNames(day).filter((name) => !supportArrangementNameFilter(name))]));
  const dayRecords = new Map(itinerary.map((day) => [Number(day.day), day]));
  for (const row of locked.itineraryOrder) {
    const names = byDay.get(row.day) ?? [];
    const requiredSpots = filterRequiredSpots(product, row.day, row.spots, dayRecords.get(row.day));
    const unorderedSpots = filterRequiredSpots(product, row.day, row.unorderedSpots ?? [], dayRecords.get(row.day));
    const allRequiredSpots = [...requiredSpots, ...unorderedSpots];
    if (mode === "complete") {
      if (!isNameSubsequence(names, requiredSpots)) {
        const missing = missingNames(names, requiredSpots);
        if (missing.length) {
          return `用户已给出完整第 ${row.day} 天行程，禁止整体重排或替换；只能规范化并核验 POI。缺失：${missing.join("、")}`;
        }
        return `用户已给出完整第 ${row.day} 天行程，景点顺序不一致，禁止整体重排或替换；期望：${requiredSpots.join(" → ")}；实际：${names.join(" → ")}`;
      }
      const missingHighlights = missingNames(names, unorderedSpots);
      if (missingHighlights.length) return `用户已给出完整第 ${row.day} 天行程，补充看点必须保留：${missingHighlights.join("、")}`;
      const extras = extraNames(names, [...row.spots, ...(row.unorderedSpots ?? [])])
        .filter((name) => !isDeletableAdministrativeLocation(product, name, row.day));
      if (extras.length) {
        return `用户已给出完整第 ${row.day} 天行程，不能新增或替换景点：${extras.join("、")}`;
      }
    } else if (!allRequiredSpots.every((spot) => names.some((name) => samePlace(name, spot)))) {
      return `已锁定的第 ${row.day} 天景点必须保留：${allRequiredSpots.join("、")}`;
    }
    const disguised = allRequiredSpots.filter(requiresLockedAttraction)
      .filter((name) => !hasTrustedOperatorNonPoiClassification(product, row.day, name)).find((name) => {
      const candidateDay = dayRecords.get(row.day);
      const currentSpots: unknown[] = Array.isArray(candidateDay?.spots) ? candidateDay.spots : [];
      const spot = currentSpots.flatMap((item) => {
        const record = asRecord(item);
        return record ? [record] : [];
      }).find((item) => samePlace(spotName(item), name));
      return spot && !requiresItineraryPoi(spot);
    });
    if (disguised) return `已锁定的第 ${row.day} 天景点必须保留为景点类型，不能用自由活动或其他活动隐藏：${disguised}`;
  }
  if (mode === "partial") {
    const allNames = itinerary.flatMap(spotNames);
    const missing = locked.pois
      .filter((poi) => !locked.itineraryOrder.some((row) => [...row.spots, ...(row.unorderedSpots ?? [])].some((spot) => samePlace(spot, poi))
        && isSupportingLockedSpot(product, row.day, poi, dayRecords.get(row.day))))
      .filter((poi) => !isDeletableAdministrativeLocation(product, poi))
      .filter((poi) => !hasTrustedOperatorAlternativeDeletionOnAnyDay(product, poi))
      .filter((poi) => !allNames.some((name) => samePlace(name, poi)));
    if (missing.length) return `已锁定的指定 POI 必须保留：${missing.join("、")}`;
    const disguised = locked.pois
      .filter((poi) => !isDeletableAdministrativeLocation(product, poi))
      .filter(requiresLockedAttraction).find((poi) => !hasTrustedOperatorAlternativeDeletionOnAnyDay(product, poi)
      && !locked.itineraryOrder.some((row) => hasTrustedOperatorNonPoiClassification(product, row.day, poi))
      && itinerary.some((day) => (Array.isArray(day.spots) ? day.spots : []).filter(asRecord)
        .some((spot) => samePlace(spotName(spot), poi) && !requiresItineraryPoi(spot))));
    if (disguised) return `已锁定的指定 POI 必须保留为景点类型，不能用自由活动或其他活动隐藏：${disguised}`;
  }
  return undefined;
}

function filterRequiredSpots(product: ProductDetail, day: number, spots: string[], nextDay?: Record<string, unknown>): string[] {
  const sourceDay = nextDay ?? (asDayList(product.product.itinerary) ?? []).find((item) => Number(item.day) === day) ?? { day };
  const currentNames = nextDay ? spotNames(nextDay) : [];
  const boundaries = nextDay ? originalRouteBoundaries(product, day) : new Set<string>();
  return spots.flatMap(splitProjectedSpots).filter((spot) =>
    !isSupportingLockedSpot(product, day, spot, nextDay)
    && !isPersistedRouteTravelNode(product.product, sourceDay, spot)
    && !isDeletableAdministrativeLocation(product, spot, day)
    && !hasTrustedOperatorNonPoiClassification(product, day, spot)
    && !hasTrustedOperatorAlternativeDeletion(product, day, spot)
    // 投影会移除相邻天共享的起终点；它们不是景点，不能反过来要求行程保留。
    && !(currentNames.length > 0 && !currentNames.some((name) => anchorKey(name) === anchorKey(spot))
      && !isLikelyAttractionAnchor(spot)
      && (boundaries.has(anchorKey(spot)) || isRouteArrivalNode(spot))));
}

/** 当天原文路线的首尾节点；只用于解释「为什么投影没有保留这个城市名」。 */
function originalRouteBoundaries(product: ProductDetail, day: number): Set<string> {
  const route = originalOvernightRoute(product.product as Record<string, unknown>, { day });
  if (!route) return new Set();
  // 天头 `【第N天 A—B—C】` 是路线摘要；正文里的同名景点不能把 B/C 挤出首尾。
  const head = route.includes("】") ? route.slice(0, route.indexOf("】")) : route;
  const tokens = orderedItineraryRoutePath(head).split(/[—–\-→]/u).map(anchorKey).filter(Boolean);
  return new Set(tokens.length ? [tokens[0]!, tokens.at(-1)!] : []);
}

function supportArrangementNameFilter(name: string): boolean {
  // Local fallback for the support-arrangement short-circuit; matches utils.spotNames.
  return /^(?:接火车站?|火车站接|送火车站?|接站|送站|接机|送机|接团|送团)(?:返程)?$/u.test(name);
}

// Re-export hasCompletePoi for callers that still depend on it from this module.
export { hasCompletePoi };

export function planningWriteContractError(
  product: ProductDetail,
  module: string,
  value: unknown,
): string | undefined {
  if (module === "itinerary") return itineraryInputContractError(product, value);
  const locked = extractLockedConstraints(product, userMessages(product));
  const record = asRecord(value);
  if (!record) return undefined;
  if (module !== "basicInfo" && module !== "skeleton" && module !== "operations") return undefined;
  if (locked.days && record.days !== undefined && Number(record.days) !== locked.days) {
    return `出行天数已锁定为 ${locked.days} 天，不能改为 ${record.days}`;
  }
  if (locked.meetingCity && text(record.meetingCity) && shortCity(record.meetingCity) !== locked.meetingCity) {
    return `meetingCity 已锁定为「${locked.meetingCity}」，不能覆盖`;
  }
  if (locked.destinationCity && text(record.destinationCity) && shortCity(record.destinationCity) !== locked.destinationCity) {
    return `destinationCity 必须与已锁定城市「${locked.destinationCity}」相同`;
  }
  if (locked.transport && record.transport !== undefined && record.transport !== locked.transport) {
    return `交通方式已锁定为 ${locked.transport}，不能覆盖`;
  }
  if ((module === "skeleton" || module === "operations") && record.hotelTier !== undefined) {
    const operations = asRecord(product.product.operations);
    const expectedTier = locked.hotelTier || normaliseHotelTier(operations?.hotelTier);
    if (expectedTier && normaliseHotelTier(record.hotelTier) !== expectedTier) {
      return `酒店档次已确定为「${expectedTier}」，不能被规划阶段改成其它档次`;
    }
  }
  return undefined;
}
