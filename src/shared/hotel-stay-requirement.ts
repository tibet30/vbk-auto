import { hotelDiamondFromTier } from "./hotel-tiers.js";
import { hotelLocationFromHotelText } from "./region-overrides.js";
import { toPlatformShortLocationName } from "./location-short-name.js";

export type HotelRatingType = "diamond" | "star" | "homestay";
export type HotelStayRequirement = {
  anchorName: string;
  cityName?: string;
  maxDistanceKm?: number;
  diamond?: number;
  ratingType?: HotelRatingType;
  ratingAlternatives?: Array<{ ratingType: HotelRatingType; diamond?: number }>;
};
type Json = Record<string, unknown>;
const text = (value: unknown) => typeof value === "string" ? value.trim() : "";
const object = (value: unknown): Json => value && typeof value === "object" && !Array.isArray(value) ? value as Json : {};

/** 用户逐日住宿地点优先于解析器选中的酒店名称，重试不能扩大到整个县。 */
export function hotelStayRequirement(product: Json, day: Json): HotelStayRequirement | undefined {
  const brief = text(object(product.basicInfo).userIdea);
  const line = brief.split(/[\n；;]/u).find(line => Number(line.match(/^\s*(?:D|第)?(\d+)(?:天|日)?\s*[-、.:：\s]/iu)?.[1]) === Number(day.day));
  const segments = line?.replace(/^\s*(?:D|第)?\d+(?:天|日)?\s*[-、.:：\s]/iu, "").split(/-+|→|—|>/u) ?? [];
  const stay = [...segments].reverse().find(segment => /(?:住|住宿)/u.test(segment) && !/不住|无住宿|无需住宿/u.test(segment));
  const nightlyClauses = [...brief.matchAll(new RegExp(`第\\s*${day.day}\\s*晚([^。；;\\n，,]*)`, "gu"))].map(match => match[1]!);
  const explicitStay = nightlyClauses.find(clause => /^(?:优先|入住|住在|住宿于|住)/u.test(clause.trim()));
  const stayText = stay ?? explicitStay;
  const projectedStay = originalDatedRouteStay(brief, day);
  const location = (stay
    ? stay.replace(/^\s*(?:入住|住宿于|住在|住)/u, "").replace(/(?:住宿|入住).*$/u, "").replace(/[，,（(].*$/u, "").trim()
    : explicitStay?.replace(/^\s*(?:优先|入住|住宿于|住在|住)\s*/u, "")
      .replace(/(?:附近|周边|当地|营地|民宿|酒店|住宿|入住).*$/u, "").replace(/[，,（(].*$/u, "").trim()) || projectedStay;
  const stored = object(day.hotelRequirement);
  const nightly = [brief.match(new RegExp(`(?:D${day.day}|第\\s*${day.day}\\s*(?:天|晚))[^。；;\\n，,]*`, "i"))?.[0] ?? "", ...nightlyClauses].join(" ");
  const gradeToken = nightly.match(/([1-5一二三四五])\s*(?:民宿)?(?:圆)?(?:钻|星)/u)?.[1];
  const initialGrade = gradeToken ? Number(gradeToken) || "一二三四五".indexOf(gradeToken) + 1 : undefined;
  const initialType: HotelRatingType | undefined = initialGrade
    ? /民宿|客栈|圆钻/u.test(nightly) ? "homestay" : /星级|[1-5一二三四五]\s*星/u.test(nightly) ? "star" : "diamond" : undefined;
  const mayInitialize = stored.diamond === undefined && stored.ratingType === undefined;
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
  const city = storedCity || poiCity || hotelLocationFromHotelText(text(day.hotel)) || hotelLocationFromHotelText(text(day.hotelDescription))
    || routeCity || text(candidates[0]?.cityName) || text(stored.cityName);
  const locality = storedAnchor && !malformedRouteAnchor ? stored.maxDistanceKm !== undefined : location ? /镇|村|古镇|片区|街区|景区|园区|山|岛/u.test(anchorName)
    || /附近|周边/u.test(stayText ?? "")
    || (!/(?:市|县|旗)$/u.test(anchorName) && city && toPlatformShortLocationName(city) !== anchorName)
    : stored.maxDistanceKm !== undefined;
  const hotelText = text(day.hotel);
  const hasDeclaredHomestayAlternative = /民宿\s*(?:\/|或|或者)\s*(?:[1-5]\s*钻)?酒店/u.test(hotelText)
    || /(?:[1-5]\s*钻)?酒店\s*(?:\/|或|或者)\s*民宿/u.test(hotelText);
  return {
    anchorName,
    ...(city ? { cityName: toPlatformShortLocationName(city) } : {}),
    // 明确镇内/景区住宿使用保守的 5km 核验边界，不能把同县几十公里外当备选。
    ...(locality ? { maxDistanceKm: Number(stored.maxDistanceKm) > 0 ? Number(stored.maxDistanceKm) : 5 } : {}),
    ...(Number.isInteger(stored.diamond) && Number(stored.diamond) >= 0 && Number(stored.diamond) <= 5 ? { diamond: Number(stored.diamond) } : {}),
    ...(["diamond", "star", "homestay"].includes(text(stored.ratingType)) ? { ratingType: stored.ratingType as HotelRatingType } : {}),
    ...(mayInitialize && initialGrade ? { diamond: initialGrade, ratingType: initialType } : {}),
    ...(hasDeclaredHomestayAlternative && !stored.ratingType ? {
      ratingAlternatives: [
        { ratingType: "diamond" as const },
        { ratingType: "homestay" as const },
      ],
    } : {}),
  };
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

export function hotelCandidateMeetsStay(candidate: Json, requirement?: HotelStayRequirement): boolean {
  if (!requirement) return true;
  const requestedAnchor = requirement.anchorName.replace(/(?:市|县|镇|村)$/u, "");
  if (requestedAnchor && !text(candidate.anchorName).includes(requestedAnchor)) return false;
  if (requirement.maxDistanceKm !== undefined) {
    const anchor = text(candidate.anchorName);
    const location = requirement.anchorName.replace(/(?:市|县|镇|村)$/u, "");
    if (!anchor.includes(location) || typeof candidate.distanceKm !== "number" || !Number.isFinite(candidate.distanceKm) || candidate.distanceKm < 0 || candidate.distanceKm > requirement.maxDistanceKm) return false;
  }
  if (requirement.cityName && toPlatformShortLocationName(text(candidate.cityName)) !== requirement.cityName) return false;
  const candidateType = (candidate.ratingType ?? "diamond") as HotelRatingType;
  if (requirement.ratingAlternatives?.length) return requirement.ratingAlternatives.some(item => item.ratingType === candidateType);
  return !requirement.ratingType || candidateType === requirement.ratingType;
}

export function hotelTierForStay(tier: string | undefined, requirement?: HotelStayRequirement): string | undefined {
  return requirement?.diamond === 0 ? "无钻酒店" : requirement?.diamond ? `当地${requirement.diamond}钻酒店` : tier;
}

export function hotelDiamondForStay(tier: string | undefined, requirement?: HotelStayRequirement): number | undefined {
  return requirement?.diamond ?? hotelDiamondFromTier(tier);
}
