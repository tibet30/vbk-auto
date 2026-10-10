import type { CtripHotelCandidate } from "../../shared/contracts-types.js";
import { hotelDiamondFromTier } from "../../shared/hotel-tiers.js";
import { HOTEL_RESOURCE_CANDIDATE_COUNT } from "../../shared/hotel-candidate-counts.js";
import { hotelCandidateMeetsStay, hotelDiamondForStay, type HotelStayRequirement } from "../../shared/hotel-stay-requirement.js";
import { toPlatformShortLocationName } from "../../shared/location-short-name.js";

/** 仅复用仍对应当前所选酒店、档次和完整核验锚点的候选。 */
export function reusableHotelCandidates(day: Record<string, unknown>, hotelTier?: string, requirement?: HotelStayRequirement): CtripHotelCandidate[] | undefined {
  const candidates = day.hotelCandidates;
  const diamond = hotelDiamondForStay(hotelTier, requirement);
  if (!Array.isArray(candidates) || !candidates.length || candidates.length > HOTEL_RESOURCE_CANDIDATE_COUNT || (diamond === undefined && !requirement?.ratingAlternatives?.length)) return undefined;
  if (!candidates.every((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const c = value as Record<string, unknown>;
    if (!hasCurrentCityAnchor(c, requirement)) return false;
    if (!hotelCandidateMeetsStay(c, requirement)) return false;
    return Number.isInteger(c.hotelId) && Number(c.hotelId) > 0 && (requirement?.ratingAlternatives?.length || c.diamond === diamond)
      && typeof c.hotelName === "string" && c.hotelName.trim()
      && typeof c.cityName === "string" && c.cityName.trim()
      && typeof c.anchorName === "string" && c.anchorName.trim()
      && Number.isInteger(c.anchorCityId) && Number(c.anchorCityId) > 0
      && typeof c.score === "number" && Number.isFinite(c.score) && c.score >= 0
      && typeof c.distanceKm === "number" && Number.isFinite(c.distanceKm) && c.distanceKm >= 0;
  })) return undefined;
  return candidates.some((c) => c.hotelName === day.hotel) ? candidates as CtripHotelCandidate[] : undefined;
}

/** 新产品没有自己的候选时，复用本地历史产品中仍满足当前约束的已核验候选。 */
export function reusableHotelCandidatesFromPool(
  pool: CtripHotelCandidate[],
  hotelTier?: string,
  requirement?: HotelStayRequirement,
): CtripHotelCandidate[] | undefined {
  if (!requirement?.anchorName && !requirement?.cityName) return undefined;
  const diamond = hotelDiamondForStay(hotelTier, requirement);
  if (!pool.length || (diamond === undefined && !requirement?.ratingAlternatives?.length)) return undefined;
  const candidates = pool.filter(candidate => {
    if (!hasCurrentCityAnchor(candidate as unknown as Record<string, unknown>, requirement)) return false;
    if (!requirement?.cityName && requirement?.maxDistanceKm === undefined) {
      const anchor = requirement?.anchorName?.trim() ?? "";
      if (!anchor || (!candidate.anchorName.includes(anchor)
        && toPlatformShortLocationName(candidate.cityName) !== toPlatformShortLocationName(anchor))) return false;
    }
    if (!hotelCandidateMeetsStay(candidate as unknown as Record<string, unknown>, requirement)) return false;
    if (requirement?.ratingAlternatives?.length) return true;
    return candidate.diamond === diamond;
  });
  const unique = [...new Map(candidates.map(candidate => [candidate.hotelId, candidate])).values()]
    .slice(0, HOTEL_RESOURCE_CANDIDATE_COUNT);
  return unique.length ? unique : undefined;
}

/** 市区住宿不能复用从同城市郊景区测得的距离；重新按城市锚点检索。 */
function hasCurrentCityAnchor(candidate: Record<string, unknown>, requirement?: HotelStayRequirement): boolean {
  if (!requirement?.cityName || requirement.maxDistanceKm !== undefined
    || toPlatformShortLocationName(requirement.anchorName) !== requirement.cityName) return true;
  if (typeof candidate.anchorName !== "string") return false;
  const anchor = candidate.anchorName.replace(/(?:市|县)?人民政府$/u, "");
  return toPlatformShortLocationName(anchor) === requirement.cityName;
}
