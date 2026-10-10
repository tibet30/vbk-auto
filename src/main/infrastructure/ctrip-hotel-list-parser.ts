import type { CtripHotelCandidate } from "../../shared/contracts-types.js";
import { HOTEL_RESOURCE_CANDIDATE_COUNT } from "../../shared/hotel-candidate-counts.js";
import { hotelDiamondFromTier } from "../../shared/hotel-tiers.js";
import type { HotelSearchContext as Context } from "./ctrip-hotel-search-types.js";
import { hotelCandidateMeetsStay } from "../../shared/hotel-stay-requirement.js";
type Coord = Context["coordinate"];
export class HotelCandidatesUnavailableError extends Error {}
/** Empty decoded results are retryable at another grade, but are not evidence of no local hotels. */
export class HotelSearchEmptyResultError extends Error {}

export function extractCtripHotelListFromHtml(html: string): unknown[] {
  const chunks = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)]
    .map((match) => nextFlightText(match[1] ?? ""))
    .filter((value): value is string => Boolean(value));
  for (const chunk of chunks) {
    const marker = '"hotelList":';
    const index = chunk.indexOf(marker);
    if (index < 0) continue;
    const parsed = parseJsonValue(chunk.slice(index + marker.length));
    if (Array.isArray(parsed)) return parsed;
  }
  throw new Error("携程酒店列表页面未包含可解析的酒店数据。");
}

export function rankCtripHotelCandidates(rows: unknown[], anchor: Context, hotelTier?: string): CtripHotelCandidate[] {
  if (!Array.isArray(rows)) throw new Error("携程酒店列表数据格式无效。");
  if (!rows.length) throw new HotelSearchEmptyResultError("携程酒店列表未返回可用候选（可能触发验证码或该日期无房）。");
  const parsed = rows.flatMap((row) => parseHotel(row, anchor))
    .filter(candidate => hotelCandidateMeetsStay(candidate as unknown as Record<string, unknown>, anchor.requirement));
  if (!parsed.length) throw new HotelCandidatesUnavailableError(`携程当前结果没有满足${anchor.requirement?.anchorName || anchor.name}${anchor.requirement?.maxDistanceKm ? `附近${anchor.requirement.maxDistanceKm}km内` : ""}地点与评级类型要求的候选；不能扩大住宿地点或据此断定当地无酒店。`);
  const candidates = hotelCandidatesForTier(parsed, hotelTier, `携程当前公开列表首屏在${anchor.cityName || "目标城市"}仅解析到 ${parsed.length} 家带有效ID和钻级的候选，尚未取得符合当地${anchor.requirement?.diamond ?? hotelDiamondFromTier(hotelTier)}钻要求的酒店；这不能证明当地没有该档次酒店，需在正常登录会话中完成官方筛选后再核验。`, anchor.requirement?.diamond);
  const sorted = candidates.sort((left, right) => right.diamond - left.diamond || left.distanceKm - right.distanceKm || right.score - left.score || left.hotelId - right.hotelId);
  const unique = [...new Map(sorted.map((candidate) => [candidate.hotelId, candidate])).values()].slice(0, HOTEL_RESOURCE_CANDIDATE_COUNT);
  if (unique.length === 0) {
    throw new Error("携程未找到带有效 hotelId/钻级的酒店，无法继续酒店资源配置。");
  }
  return unique;
}

export function hotelCandidatesForTier(candidates: CtripHotelCandidate[], hotelTier?: string, unavailableMessage?: string, requiredDiamond?: number): CtripHotelCandidate[] {
  const diamond = requiredDiamond ?? hotelDiamondFromTier(hotelTier);
  if (diamond === undefined) return candidates;
  const matched = candidates.filter((candidate) => candidate.diamond === diamond);
  if (!matched.length) throw new HotelCandidatesUnavailableError(unavailableMessage || `携程当前结果未返回符合当地${diamond}钻要求的酒店候选；不能据此断定当地没有该档次酒店。`);
  return matched;
}

function nextFlightText(source: string): string | null {
  if (!source.includes("initListData") || !source.includes("self.__next_f.push")) return null;
  const match = source.match(/^\s*self\.__next_f\.push\(([\s\S]*?)\);?\s*$/);
  if (!match) return null;
  try {
    const value = JSON.parse(match[1] ?? "");
    return findFlightText(value);
  } catch { return null; }
}
function findFlightText(value: unknown): string | null {
  if (typeof value === "string") return value.includes("initListData") ? value : null;
  if (!Array.isArray(value)) return null;
  for (const item of value) {
    const found = findFlightText(item);
    if (found) return found;
  }
  return null;
}
function parseJsonValue(source: string): unknown {
  const start = source.search(/[\[{]/);
  if (start < 0) return null;
  const open = source[start]!; const close = open === "[" ? "]" : "}";
  let depth = 0; let quote = ""; let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const current = source[index]!;
    if (quote) {
      if (escaped) escaped = false;
      else if (current === "\\") escaped = true;
      else if (current === quote) quote = "";
      continue;
    }
    if (current === '"') { quote = current; continue; }
    if (current === open) depth += 1;
    if (current === close && --depth === 0) {
      try { return JSON.parse(source.slice(start, index + 1)); } catch { return null; }
    }
  }
  return null;
}

function parseHotel(raw: unknown, anchor: Context): CtripHotelCandidate[] {
  const row = record(raw); const info = record(row?.hotelInfo); const summary = record(info?.summary);
  const nameInfo = record(info?.nameInfo); const star = record(info?.hotelStar); const comment = record(info?.commentInfo);
  const position = record(info?.positionInfo); const hotelId = positive(summary?.hotelId); const hotelName = text(nameInfo?.name);
  const diamond = star?.star === undefined || star?.star === null ? null : number(star.star); const starType = number(star?.starType); const coordinate = hotelCoordinates(position?.mapCoordinate);
  const cityId = positive(position?.cityId); const cityName = text(position?.cityName);
  // 城市筛选页可能混入邻市卡片；缺少携程卡片城市 ID 也不能借锚点默认放行。
  // hotelTier 的“钻”只接受携程 diamond（starType 0）；星级酒店和民宿圆钻不是同一档位。
  const ratingType = starType === 0 ? "diamond" : starType === 1 ? "star" : starType === 2 ? "homestay" : undefined;
  const acceptedType = anchor.requirement?.ratingType ?? "diamond";
  if (!hotelId || !hotelName || diamond === null || !Number.isInteger(diamond) || diamond < 0 || diamond > 5 || ratingType !== acceptedType || !coordinate || cityId !== anchor.cityId || !cityName) return [];
  const distanceKm = haversineKm(anchor.coordinate, coordinate);
  const score = number(comment?.commentScore) ?? 0;
  return [{ hotelId, hotelName, diamond, score, distanceKm: Math.round(distanceKm * 100) / 100,
    address: text(position?.address) || undefined, cityName,
    anchorName: anchor.name, anchorCityId: anchor.cityId, ratingType }];
}

function hotelCoordinates(value: unknown): Coord | null {
  const rows = Array.isArray(value) ? value.map(record).filter(Boolean) : [];
  const sorted = rows.sort((left, right) => Number(left?.coordinateType ?? 9) - Number(right?.coordinateType ?? 9));
  for (const row of sorted) {
    const latitude = number(row?.latitude); const longitude = number(row?.longitude);
    if (latitude !== null && longitude !== null && (latitude !== 0 || longitude !== 0)) return { latitude, longitude };
  }
  return null;
}
function haversineKm(left: Coord, right: Coord) {
  const radians = (value: number) => value * Math.PI / 180;
  const a = Math.sin(radians(right.latitude - left.latitude) / 2) ** 2
    + Math.cos(radians(left.latitude)) * Math.cos(radians(right.latitude)) * Math.sin(radians(right.longitude - left.longitude) / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
function record(value: unknown): Record<string, unknown> | null { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null; }
function text(value: unknown): string { return typeof value === "string" ? value.trim() : ""; }
function positive(value: unknown): number | null { const parsed = Number(value); return Number.isInteger(parsed) && parsed > 0 ? parsed : null; }
function number(value: unknown): number | null { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : null; }
