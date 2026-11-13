import { hotelLocationFromHotelText, toWritableAdministrativeCityName } from "./region-overrides.js";
import { toPlatformShortLocationName } from "./location-short-name.js";
import { constraintUserIdea } from "./product-idea-optimization.js";

export type HotelRatingType = "diamond" | "star" | "homestay";
/**
 * 住宿要求只剩「当晚住哪」：住宿地锚点与行政城市。
 *
 * 逐晚钻级、民宿/星级、距离上限按产品规范不再保留（平台统一自动匹配三/四/五钻）。
 * 类型上仍保留这三个旧字段，只用于读取历史数据时兼容旧候选链路；本模块不再从
 * 用户原文推导它们，新写入也一律不带这些字段。
 */
export type HotelStayRequirement = {
  anchorName: string;
  cityName?: string;
  /** @deprecated 历史候选链路只读兼容，不再从用户原文推导。 */
  maxDistanceKm?: number;
  /** @deprecated 历史候选链路只读兼容，不再从用户原文推导。 */
  diamond?: number;
  /** @deprecated 历史候选链路只读兼容，不再从用户原文推导。 */
  ratingType?: HotelRatingType;
  /** @deprecated 历史候选链路只读兼容，不再从用户原文推导。 */
  ratingAlternatives?: Array<{ ratingType: HotelRatingType; diamond?: number }>;
};
type Json = Record<string, unknown>;
const text = (value: unknown) => typeof value === "string" ? value.trim() : "";
const object = (value: unknown): Json => value && typeof value === "object" && !Array.isArray(value) ? value as Json : {};

/** 用户逐日住宿地点优先于解析器选中的酒店名称，重试不能扩大到整个县。 */
export function hotelStayRequirement(product: Json, day: Json): HotelStayRequirement | undefined {
  const brief = constraintUserIdea(product.basicInfo);
  const line = originalDaySection(brief, Number(day.day));
  const segments = line?.replace(/^\s*(?:D|第)?\d+(?:天|日)?\s*[-、.:：\s]/iu, "").split(/-+|→|—|>/u) ?? [];
  const stay = [...segments].reverse().find(segment => /(?:宿|住|住宿)/u.test(segment) && !/不住|无住宿|无需住宿/u.test(segment));
  const nightlyClauses = [...brief.matchAll(new RegExp(`第\\s*${day.day}\\s*晚([^。；;\\n，,]*)`, "gu"))].map(match => match[1]!);
  const explicitStay = nightlyClauses.find(clause => /^(?:优先|入住|住在|住宿于|住)/u.test(clause.trim()));
  const projectedStay = originalDatedRouteStay(brief, day);
  const parenthesizedStay = stay?.match(/[（(]\s*宿\s*([^）)]+)[）)]/u)?.[1]?.trim();
  const location = (parenthesizedStay || (stay
    ? stay.replace(/^\s*(?:入住|住宿于|住在|住)/u, "").replace(/(?:住宿|入住).*$/u, "").replace(/[，,（(].*$/u, "").trim()
    : explicitStay?.replace(/^\s*(?:优先|入住|住宿于|住在|住)\s*/u, "")
      .replace(/(?:附近|周边|当地|营地|民宿|酒店|住宿|入住).*$/u, "").replace(/[，,（(].*$/u, "").trim())) || projectedStay;
  const stored = object(day.hotelRequirement);

  // A persisted, explicitly chosen lodging anchor is authoritative. Otherwise
  // the next reconciliation would rebuild the old anchor from userIdea and
  // silently undo a later "改住市区" decision.
  const storedAnchor = text(stored.anchorName);
  // Older single-hyphen routes were stored verbatim as the lodging anchor.
  // Repair only that parser artifact; explicit later anchor choices still win.
  const malformedRouteAnchor = location && /[-→—>].*(?:住|住宿)/u.test(storedAnchor)
    && line?.includes(storedAnchor);
  const anchorName = (malformedRouteAnchor ? location : storedAnchor) || location;
  if (!anchorName) return undefined;
  // 住宿字段可能只写“留侯镇当地民宿”这类落脚点。此时优先取住宿前
  // 最近的行政地点，避免沿用产品接团城市或旧的错误 cityName。
  const routeCity = [...segments].slice(0, Math.max(0, segments.length - 1)).reverse()
    .map(segment => segment.match(/([\p{Script=Han}]{1,12}(?:自治县|县级市|市|县|旗))/u)?.[1] ?? "")
    .find(Boolean);
  const candidates = Array.isArray(day.hotelCandidates) ? day.hotelCandidates.map(object) : [];
  const anchorSpot = (Array.isArray(day.spots) ? day.spots.map(object) : []).find(spot =>
    Number(spot.poiId) > 0 && [text(spot.name), text(spot.poiName)].some(name => name && (name.includes(anchorName) || anchorName.includes(name))));
  const poiCity = text(anchorSpot?.district) || text(anchorSpot?.city);
  const storedCity = text(storedAnchor) && text(stored.cityName) ? text(stored.cityName) : "";
  // Repair only an inherited arrival-city default. A saved overnight city
  // can be more specific than the POI's broad administrative parent (for
  // example, Mangya rather than Haixi) and must remain authoritative.
  const basic = object(product.basicInfo);
  const arrivalCity = toPlatformShortLocationName(text(basic.meetingCity) || text(basic.destinationCity));
  const inheritedArrivalCity = arrivalCity && toPlatformShortLocationName(storedCity) === arrivalCity;
  const district = text(anchorSpot?.district);
  const parentCity = text(anchorSpot?.city);
  const specificDistrict = district && parentCity
    && toPlatformShortLocationName(district) !== toPlatformShortLocationName(parentCity);
  const explicitOvernightCity = parenthesizedStay ? toWritableAdministrativeCityName(parenthesizedStay) : "";
  const city = explicitOvernightCity || (inheritedArrivalCity && specificDistrict ? poiCity : "") || storedCity || poiCity
    || hotelLocationFromHotelText(text(day.hotel)) || hotelLocationFromHotelText(text(day.hotelDescription))
    || routeCity || text(candidates[0]?.cityName) || text(stored.cityName);
  return {
    anchorName,
    ...(city ? { cityName: toPlatformShortLocationName(city) } : {}),
    // 仅回读历史产品已保存的档位/距离，绝不从用户原文重新推导。
    ...(Number.isInteger(stored.diamond) && Number(stored.diamond) >= 0 && Number(stored.diamond) <= 5 ? { diamond: Number(stored.diamond) } : {}),
    ...(["diamond", "star", "homestay"].includes(text(stored.ratingType)) ? { ratingType: stored.ratingType as HotelRatingType } : {}),
    ...(Number(stored.maxDistanceKm) > 0 ? { maxDistanceKm: Number(stored.maxDistanceKm) } : {}),
  };
}

function originalDaySection(brief: string, dayNumber: number): string | undefined {
  brief = brief.replace(/\\[nr]/gu, '\n');
  const marker = /(?:^|[\s；;])(?:(?:D(?:ay)?|第)\s*)?(\d+)(?:天|日)?\s*[-、.:：\s]/giu;
  const matches = [...brief.matchAll(marker)];
  const current = matches.find((match) => Number(match[1]) === dayNumber);
  if (!current || current.index === undefined) return undefined;
  const next = matches.find((match) => (match.index ?? -1) > current.index!);
  return brief.slice(current.index, next?.index ?? brief.length).replace(/^[\s；;]+/u, "")
    .split(/\r?\n/u)[0]?.trim();
}

/** The generated overnight placeholder is evidence only when it matches this day's original endpoint. */
function originalDatedRouteStay(brief: string, day: Json): string | undefined {
  const placeholder = text(day.hotel).match(/^(.+?)区域酒店[（(]待核验[）)]$/u)?.[1];
  if (!placeholder) return undefined;
  const line = brief.replace(/\*\*/gu, '').split(/[\n\r]+/u).find(line =>
    new RegExp(`^\\s*(?:\\d{1,2}\\s*月\\s*\\d{1,2}\\s*号\\s*)?D${day.day}\\s*[:：]`, 'iu').test(line));
  const route = line?.replace(/^\s*(?:\d{1,2}\s*月\s*\d{1,2}\s*号\s*)?D\d{1,2}\s*[:：]\s*/iu, '')
    .replace(/[（(][^）)]+[）)]/gu, '').split(/\s*[-—–→]+\s*/u);
  return route && route.length > 1 && route.at(-1)?.trim() === placeholder ? placeholder : undefined;
}
