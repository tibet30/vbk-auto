/**
 * POI AI 裁决：路线规则判不了（地域未证实、同名多候选）时，把同省、身份兼容的
 * 候选连同当天原路线、行政锚点、邻近已核验景点和走廊距离交给 AI 选择。
 *
 * AI 只能在硬门内选：候选必须在本次结果里且可选、身份兼容、与产品省份一致；
 * 规则未认可地域的候选还要 ≥ 0.9 置信度与地理佐证（走廊 160 km 内，或候选
 * 城市就是路线锚点/目的地/当天原文点名的城市）。AI 出错只记日志、按不确定处理。
 */

import type { PoiSuggestCandidate, PoiSuggestDetailResult } from "../../shared/contracts-types.js";
import { toPlatformShortLocationName } from "../../shared/location-short-name.js";
import { originalOvernightRoute } from "../../shared/original-itinerary-route.js";
import { isCompatiblePoiIdentity } from "../../shared/poi-candidate-identity.js";
import { currentRouteLocations, routeCorridorDistanceKm, routeLocationsForSpot } from "../../shared/route-location-evidence.js";
import { ROUTE_CORRIDOR_RADIUS_KM } from "../../shared/route-corridor.js";
import { logInfo, logWarn } from "../../shared/log-timestamp.js";
import { isSelectableCandidate } from "./poi-uncertain-reason.js";
import type { PoiAutoDisambiguator } from "./poi-auto-selection.js";

type Json = Record<string, any>;
type Candidate = PoiSuggestCandidate & { poiName: string; poiId: number };

/** 规则已认可地域的 AI 选择沿用原阈值（> 0.8）；规则外或同名多候选要求 ≥ 0.9。 */
export const AI_ADJUDICATION_MIN_CONFIDENCE = 0.9;
/** 规则外候选到当日已核验路线折线的最大距离：走廊半径的两倍。 */
export const AI_ADJUDICATION_MAX_DISTANCE_KM = ROUTE_CORRIDOR_RADIUS_KM * 2;
const MAX_CHOICES = 12;

export interface PoiAiAdjudication {
  candidate?: Candidate;
  /** AI 有选择但被硬门拒绝时的门名；confidence 表示置信度不足。 */
  rejectedBy?: string;
  confidence?: number;
  /** 候选是否本就通过路线规则地域判定；false 时需要写裁决凭证。 */
  inRule?: boolean;
  reasoning?: string;
}

export async function adjudicatePoiWithAi(args: {
  localProductId: string;
  keyword: string;
  product: Json;
  province?: string;
  dayNumber: number;
  detail: PoiSuggestDetailResult;
  /** 同名多候选：即使规则已认可也按规则外阈值裁决。 */
  ambiguous: boolean;
  inRule(candidate: Candidate): boolean;
  disambiguate: PoiAutoDisambiguator;
}): Promise<PoiAiAdjudication> {
  const province = toPlatformShortLocationName(args.province);
  const pool = candidatePool(args, province);
  if (!pool.length) return {};
  const labelled = pool.map(candidate => ({ candidate, inRule: args.inRule(candidate),
    distanceKm: routeCorridorDistanceKm(args.product, args.dayNumber, candidate) }));
  const choices = labelled.map(item => ({ ...item, text: candidateLabel(item.candidate, item.inRule, item.distanceKm) }));
  let outcome: Awaited<ReturnType<PoiAutoDisambiguator>>;
  try {
    outcome = await args.disambiguate({
      localProductId: args.localProductId,
      desired: args.keyword,
      product: args.product,
      candidates: choices.map(choice => ({ id: String(choice.candidate.poiId), text: choice.text })),
      context: adjudicationContext(args.product, args.keyword, args.dayNumber, province),
    });
  } catch (error) {
    logWarn("[POI] ai-adjudication failed", { localProductId: args.localProductId, keyword: args.keyword,
      candidates: choices.length, error: error instanceof Error ? error.message : String(error) });
    return {};
  }
  const picked = choices.find(choice => choice.text === outcome.pickedText);
  const rejected = !picked ? "no-pick" : rejection(args, picked, outcome.confidence, province);
  logInfo("[POI] ai-adjudication", { localProductId: args.localProductId, keyword: args.keyword, day: args.dayNumber,
    candidates: choices.length, pickedPoiId: picked?.candidate.poiId ?? null, confidence: outcome.confidence,
    inRule: picked?.inRule ?? null, distanceKm: picked?.distanceKm === undefined ? null : Math.round(picked.distanceKm),
    accepted: !rejected, rejectedBy: rejected || null, reasoning: outcome.reasoning ?? null });
  if (!picked) return {};
  if (rejected) return { rejectedBy: rejected };
  return { candidate: picked.candidate, confidence: outcome.confidence, inRule: picked.inRule,
    ...(outcome.reasoning ? { reasoning: outcome.reasoning } : {}) };
}

/** 规则认可的候选在前；省份已知时补充同省身份兼容的候选。 */
function candidatePool(args: { keyword: string; detail: PoiSuggestDetailResult; inRule(candidate: Candidate): boolean },
  province: string): Candidate[] {
  const selectable = args.detail.candidates.filter((item): item is Candidate => isSelectableCandidate(item));
  const approved = selectable.filter(item => args.inRule(item));
  const extra = province ? selectable.filter(item => !approved.includes(item)
    && isCompatiblePoiIdentity(args.keyword, item.poiName)
    && toPlatformShortLocationName(item.province) === province) : [];
  const seen = new Set<number>();
  return [...approved, ...extra].filter(item => !seen.has(item.poiId) && Boolean(seen.add(item.poiId))).slice(0, MAX_CHOICES);
}

function rejection(args: { keyword: string; product: Json; dayNumber: number; ambiguous: boolean },
  picked: { candidate: Candidate; inRule: boolean; distanceKm?: number }, confidence: number, province: string): string {
  const { candidate } = picked;
  if (!isCompatiblePoiIdentity(args.keyword, candidate.poiName)) return "identity";
  if (picked.inRule && !args.ambiguous) return confidence > 0.8 ? "" : "confidence";
  if (!province || toPlatformShortLocationName(candidate.province) !== province) return "province";
  if (confidence < AI_ADJUDICATION_MIN_CONFIDENCE) return "confidence";
  if (picked.inRule) return "";
  if (picked.distanceKm !== undefined) return picked.distanceKm <= AI_ADJUDICATION_MAX_DISTANCE_KM ? "" : "distance";
  return cityEvidence(args.product, args.dayNumber, candidate) ? "" : "geo-evidence";
}

/** 没有可算距离时：候选城市必须是路线锚点、目的地/集合城市，或当天原文点名的城市/区县。 */
function cityEvidence(product: Json, dayNumber: number, candidate: Candidate): boolean {
  const city = toPlatformShortLocationName(candidate.city);
  const district = toPlatformShortLocationName(candidate.district);
  if (!city) return false;
  const basic = product.basicInfo ?? {};
  const anchors = itinerary(product).flatMap(day => currentRouteLocations(product, day).map(node => node.city));
  const known = new Set([...anchors, basic.destinationCity, basic.meetingCity].map(toPlatformShortLocationName).filter(Boolean));
  if (known.has(city)) return true;
  const day = itinerary(product).find(value => Number(value.day) === dayNumber);
  const route = day ? (originalOvernightRoute(product, day) ?? "").replace(/\s+/gu, "") : "";
  return Boolean(route) && [city, district].some(name => name.length >= 2 && route.includes(name));
}

function adjudicationContext(product: Json, keyword: string, dayNumber: number, province: string): Record<string, unknown> {
  const days = itinerary(product);
  const day = days.find(value => Number(value.day) === dayNumber);
  const routeOf = (offset: number) => {
    const value = days.find(item => Number(item.day) === dayNumber + offset);
    // 「Day1：」后的冒号会留在原路线开头，给 AI 看时去掉。
    return value ? originalOvernightRoute(product, value)?.replace(/^[\s:：]+/u, "") ?? null : null;
  };
  const basic = product.basicInfo ?? {};
  return {
    task: "判断哪个候选就是这一天行程要去的景点；看名称、所在省市区、与当天已核验路线的距离是否符合当天原路线的走向",
    day: Number.isFinite(dayNumber) ? dayNumber : null,
    originalRoute: { previousDay: routeOf(-1), currentDay: routeOf(0), nextDay: routeOf(1) },
    routeAnchors: day ? currentRouteLocations(product, day).map(node => ({ name: node.name, city: node.city,
      ...(node.district ? { district: node.district } : {}) })) : [],
    adjacentAnchorCities: day ? routeLocationsForSpot(product, day, keyword).map(location => location.city) : [],
    verifiedNearbyPois: days.filter(value => Math.abs(Number(value.day) - dayNumber) <= 1).flatMap(value =>
      (Array.isArray(value.spots) ? value.spots : []).filter((spot: Json) => spot?.poiId && spot.poiName && spot.name !== keyword)
        .map((spot: Json) => ({ day: Number(value.day), name: spot.name, poiName: spot.poiName,
          ...(spot.city ? { city: spot.city } : {}), ...(spot.district ? { district: spot.district } : {}) }))),
    province: province || null,
    destinationCity: basic.destinationCity ?? null,
    meetingCity: basic.meetingCity ?? null,
  };
}

function candidateLabel(candidate: Candidate, inRule: boolean, distanceKm: number | undefined): string {
  const location = [candidate.province, candidate.city, candidate.district]
    .filter((value): value is string => Boolean(value?.trim())).join("/");
  return [candidate.poiName, location || "地域未知",
    distanceKm === undefined ? "无可比对的已核验路线" : `距当日已核验路线约 ${Math.round(distanceKm)} km`,
    `规则地域：${inRule ? "已认可" : "未证实"}`, `POI ${candidate.poiId}`].join(" · ");
}

function itinerary(product: Json): Json[] {
  return (Array.isArray(product.itinerary) ? product.itinerary : []).filter((day: unknown): day is Json =>
    Boolean(day) && typeof day === "object");
}
