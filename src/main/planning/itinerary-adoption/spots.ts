/**
 * itinerary 必填景点 + POI 应用策略：
 *   - collectRequiredItinerarySpots：收集当前 itinerary 中需要真实 POI 的可游览景点
 *     （不含交通节点 / 自由活动 / other 等 kind）；
 *   - isTravelNodeName：识别接送 / 火车站 / 酒店等交通节点；
 *   - applyPoiMatches：把 { name → { poiName, poiId } } 应用到 itinerary；未命中记入 missing；
 *   - applyUnmatchedPoiSourcePolicy：用户点名的未命中保留（poiName/poiId=null），
 *     AI 自荐但未命中的从行程中移除；
 *   - findUserRecommendedSpotNames：从用户消息里识别被点名的景点（兼容括号 / 前后缀）；
 *   - itineraryHasRequiredPois：所有 required spots 都有 poiName + poiId 才算通过；
 *
 * RequiredItinerarySpot：dayIndex + spotIndex + name + travelNode 标记。
 */

import { requiresItineraryPoi } from "../../../shared/itinerary-activity-kind.js";
import type { RequiredItinerarySpot } from "./state-types.js";
import { SETTLEMENT_NODE_NAMES, asRecord, normaliseMentionText, positiveInteger, text } from "./utils.js";

export type { RequiredItinerarySpot } from "./state-types.js";

/** 收集当前 itinerary 中必须拥有真实 POI 的可游览景点。 */
export function collectRequiredItinerarySpots(itinerary: unknown): RequiredItinerarySpot[] {
  const result: RequiredItinerarySpot[] = [];
  for (const [dayIndex, day] of (Array.isArray(itinerary) ? itinerary : []).entries()) {
    const record = asRecord(day);
    for (const [spotIndex, spot] of (Array.isArray(record?.spots) ? record.spots : []).entries()) {
      const value = asRecord(spot);
      const name = text(value?.name) || text(value?.poiName) || (typeof spot === "string" ? spot.trim() : "");
      if (!name) continue;
      if (value && !requiresItineraryPoi(value)) continue;
      result.push({ dayIndex, spotIndex, name, travelNode: isTravelNodeName(name) });
    }
  }
  return result;
}

export function isTravelNodeName(value: string): boolean {
  const name = value.trim();
  if (!name) return false;
  if (SETTLEMENT_NODE_NAMES.has(name)) return true;
  if (/(城区|市区|县城|镇区)$/.test(name)) return true;
  return /(机场|航站楼|火车站|高铁站|动车站|汽车站|客运站|码头|酒店|宾馆|民宿|客栈|住宿|入住|集合|接送|接机|送机|接站|送站)/.test(name);
}

export function applyPoiMatches(
  itinerary: unknown,
  matches: ReadonlyMap<string, { poiName: string; poiId: number }>,
): { itinerary: Array<Record<string, unknown>>; missing: RequiredItinerarySpot[] } {
  const next = structuredClone(Array.isArray(itinerary) ? itinerary : []) as Array<Record<string, unknown>>;
  const missing: RequiredItinerarySpot[] = [];
  for (const spot of collectRequiredItinerarySpots(next)) {
    if (spot.travelNode) continue;
    const day = asRecord(next[spot.dayIndex]);
    const spots = Array.isArray(day?.spots) ? day.spots as unknown[] : [];
    const current = asRecord(spots[spot.spotIndex]);
    const match = matches.get(spot.name);
    if (!match) {
      missing.push(spot);
      continue;
    }
    if (current) {
      current.poiName = match.poiName;
      current.poiId = match.poiId;
    } else {
      spots[spot.spotIndex] = { name: spot.name, poiName: match.poiName, poiId: match.poiId };
    }
    if (day) day.spots = spots;
  }
  return { itinerary: next, missing };
}

/** 用户点名的未命中景点保留；AI 自荐但未命中的景点从行程中移除。 */
export function applyUnmatchedPoiSourcePolicy(
  itinerary: unknown,
  matches: ReadonlyMap<string, { poiName: string; poiId: number }>,
  userRecommendedSpotNames: ReadonlySet<string>,
): { itinerary: Array<Record<string, unknown>>; missing: RequiredItinerarySpot[]; removed: RequiredItinerarySpot[] } {
  const hydrated = applyPoiMatches(itinerary, matches);
  const next = hydrated.itinerary;
  const removed: RequiredItinerarySpot[] = [];
  const retainedMissing: RequiredItinerarySpot[] = [];
  const missingByDay = new Map<number, RequiredItinerarySpot[]>();
  for (const spot of hydrated.missing) {
    const items = missingByDay.get(spot.dayIndex) ?? [];
    items.push(spot);
    missingByDay.set(spot.dayIndex, items);
  }
  for (const [dayIndex, spots] of missingByDay) {
    const day = asRecord(next[dayIndex]);
    const daySpots = Array.isArray(day?.spots) ? day.spots as unknown[] : [];
    for (const spot of [...spots].sort((a, b) => b.spotIndex - a.spotIndex)) {
      if (userRecommendedSpotNames.has(spot.name)) {
        const current = asRecord(daySpots[spot.spotIndex]);
        if (current) {
          current.poiName = null;
          current.poiId = null;
        } else daySpots[spot.spotIndex] = { name: spot.name, poiName: null, poiId: null };
        retainedMissing.unshift(spot);
      }
      else {
        daySpots.splice(spot.spotIndex, 1);
        removed.unshift(spot);
      }
    }
    if (day) day.spots = daySpots;
  }
  return { itinerary: next, missing: retainedMissing, removed };
}

export function findUserRecommendedSpotNames(itinerary: unknown, userMessage: string): string[] {
  const message = normaliseMentionText(userMessage);
  if (!message) return [];
  const names = collectRequiredItinerarySpots(itinerary)
    .filter((spot) => !spot.travelNode)
    .map((spot) => spot.name)
    .filter((name) => {
      const full = normaliseMentionText(name);
      const base = normaliseMentionText(name.split(/[（(]/, 1)[0] ?? "");
      return Boolean((full.length >= 2 && message.includes(full)) || (base.length >= 2 && message.includes(base)));
    });
  return [...new Set(names)];
}

export function itineraryHasRequiredPois(itinerary: unknown): boolean {
  const spots = collectRequiredItinerarySpots(itinerary).filter((spot) => !spot.travelNode);
  const days = Array.isArray(itinerary) ? itinerary : [];
  if (days.length === 0 || days.some((day) => {
    const record = asRecord(day); const daySpots = record?.spots;
    return !Array.isArray(daySpots) || daySpots.length === 0 || daySpots.some((spot) => !text(asRecord(spot)?.name) && !text(asRecord(spot)?.poiName));
  })) return false;
  if (spots.length === 0) return true;
  return spots.every((spot) => {
    const day = asRecord(days[spot.dayIndex]);
    const value = asRecord(Array.isArray(day?.spots) ? day.spots[spot.spotIndex] : undefined);
    return Boolean(text(value?.poiName) && positiveInteger(value?.poiId));
  });
}