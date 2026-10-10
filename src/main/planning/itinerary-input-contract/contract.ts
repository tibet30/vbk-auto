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
  asDayList,
  asRecord,
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
    const requiredSpots = row.spots.filter((spot) =>
      !isSupportingLockedSpot(product, row.day, spot, dayRecords.get(row.day))
      && !isDeletableAdministrativeLocation(product, spot, row.day)
      && !hasTrustedOperatorAlternativeDeletion(product, row.day, spot));
    if (mode === "complete") {
      if (!isNameSubsequenceLocal(names, requiredSpots)) {
        return `用户已给出完整第 ${row.day} 天行程，禁止整体重排或替换；只能规范化并核验 POI。缺失：${missingNamesLocal(names, requiredSpots).join("、") || requiredSpots.join("、")}`;
      }
      const extras = extraNamesLocal(names, row.spots);
      if (extras.length) {
        return `用户已给出完整第 ${row.day} 天行程，不能新增或替换景点：${extras.join("、")}`;
      }
    } else if (!requiredSpots.every((spot) => names.some((name) => samePlace(name, spot)))) {
      return `已锁定的第 ${row.day} 天景点必须保留：${requiredSpots.join("、")}`;
    }
    const disguised = requiredSpots.filter(requiresLockedAttraction).find((name) => {
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
      .filter((poi) => !locked.itineraryOrder.some((row) => row.spots.some((spot) => samePlace(spot, poi))
        && isSupportingLockedSpot(product, row.day, poi, dayRecords.get(row.day))))
      .filter((poi) => !isDeletableAdministrativeLocation(product, poi))
      .filter((poi) => !hasTrustedOperatorAlternativeDeletionOnAnyDay(product, poi))
      .filter((poi) => !allNames.some((name) => samePlace(name, poi)));
    if (missing.length) return `已锁定的指定 POI 必须保留：${missing.join("、")}`;
    const disguised = locked.pois.filter(requiresLockedAttraction).find((poi) => !hasTrustedOperatorAlternativeDeletionOnAnyDay(product, poi)
      && itinerary.some((day) => (Array.isArray(day.spots) ? day.spots : []).filter(asRecord)
        .some((spot) => samePlace(spotName(spot), poi) && !requiresItineraryPoi(spot))));
    if (disguised) return `已锁定的指定 POI 必须保留为景点类型，不能用自由活动或其他活动隐藏：${disguised}`;
  }
  return undefined;
}

function isNameSubsequenceLocal(haystack: string[], needles: string[]): boolean {
  let index = 0;
  for (const name of haystack) {
    if (index < needles.length && samePlace(name, needles[index]!)) index += 1;
  }
  return index === needles.length;
}
function missingNamesLocal(haystack: string[], needles: string[]): string[] {
  return needles.filter((needle) => !haystack.some((name) => samePlace(name, needle)));
}
function extraNamesLocal(haystack: string[], needles: string[]): string[] {
  return haystack.filter((name) => !needles.some((needle) => samePlace(name, needle)));
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