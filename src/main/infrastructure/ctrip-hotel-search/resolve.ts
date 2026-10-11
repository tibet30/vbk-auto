import type { CtripHotelCandidate } from "../../../shared/contracts-types.js";
import { hotelDiamondFromTier } from "../../../shared/hotel-tiers.js";
import { hotelTierForStay, type HotelStayRequirement } from "../../../shared/hotel-stay-requirement.js";
import { nightlyHotelAlternatives } from "../ctrip-hotel-locality.js";
import { reusableHotelCandidates, reusableHotelCandidatesFromPool } from "../ctrip-hotel-candidate-cache.js";
import { HotelCandidatesUnavailableError, HotelSearchEmptyResultError } from "../ctrip-hotel-list-parser.js";
import type { HotelSearchContext as Context } from "../ctrip-hotel-search-types.js";
import { nextHotelSearchDates, fetchCtripHotelContext } from "./provider.js";
import { selectCtripHotelContext } from "./context.js";
import { limitItineraryHotelStays, shouldResolveItineraryHotelForDay, hotelSearchContextCityForDay, hotelSearchAnchorNames } from "./itinerary-policy.js";
import { fetchHotelCandidatesWithFallback, isHotelDowngradeAllowed } from "./matching.js";
import { applyHotelCandidates } from "./projection.js";
import { text } from "./helpers.js";

async function resolveItineraryHotelCandidates(
  itinerary: Array<Record<string, unknown>>,
  preferredCity?: string,
  nights?: number,
  hotelTier?: string,
  onProgress?: (result: { itinerary: Array<Record<string, unknown>>; dailyCandidates: Array<{ day: number; candidates: CtripHotelCandidate[] }>; searchDates: { checkin: string; checkout: string } }) => Promise<void> | void,
  requirements?: Map<number, HotelStayRequirement>,
  allowDowngrade: boolean | Map<number, boolean> = false,
  candidatePool: CtripHotelCandidate[] = [],
  fetcher: typeof fetch = fetch,
) {
  const dates = nextHotelSearchDates();
  const dailyCandidates: Array<{ day: number; candidates: CtripHotelCandidate[] }> = [];
  const nextItinerary = structuredClone(itinerary);
  limitItineraryHotelStays(nextItinerary, nights);
  const failures: string[] = [];
  for (const [index, day] of nextItinerary.entries()) {
    if (!shouldResolveItineraryHotelForDay(day, index, nights)) continue;
    const requirement = requirements?.get(Number(day.day));
    const dayTier = hotelTierForStay(hotelTier, requirement);
    const saved = reusableHotelCandidates(day, dayTier, requirement);
    const reusable = saved ?? reusableHotelCandidatesFromPool(candidatePool, dayTier, requirement);
    if (reusable) {
      applyHotelCandidates(day, reusable, requirement);
      dailyCandidates.push({ day: Number(day.day), candidates: reusable });
      await onProgress?.({ itinerary: structuredClone(nextItinerary), dailyCandidates: structuredClone(dailyCandidates), searchDates: dates });
      continue;
    }
    const contextCity = requirement?.anchorName ? requirement.cityName : hotelSearchContextCityForDay(day, preferredCity);
    const anchorNames = requirement?.maxDistanceKm !== undefined
      ? [...new Set([requirement.anchorName, ...(hotelSearchAnchorNames(day, preferredCity).filter(name => name.includes(requirement.anchorName.replace(/(?:镇|村)$/u, ""))))])]
      : requirement?.anchorName
        ? [requirement.anchorName]
      : hotelSearchAnchorNames(day, preferredCity);
    let anchor: Context | undefined;
    let candidates: CtripHotelCandidate[] | undefined;
    let searchFailure: unknown;
    const searchedContexts = new Set<string>();
    try {
      for (const anchorName of anchorNames) {
        const contexts = await fetchCtripHotelContext(anchorName, fetcher);
        try {
          anchor = selectCtripHotelContext(contexts, {
            anchorName, preferredCity: nightlyHotelAlternatives(text(day.hotel)).length ? undefined : contextCity, requirePreferredCity: Boolean(contextCity) && !nightlyHotelAlternatives(text(day.hotel)).length,
            requirement: nightlyHotelAlternatives(text(day.hotel)).length ? { ...requirement, anchorName, maxDistanceKm: requirement?.maxDistanceKm ?? 5 } : requirement,
          });
          // Alias suggestions can resolve to the same official landmark. Do not
          // restart the complete tier budget for that identical query context.
          const contextKey = JSON.stringify([anchor.cityId, anchor.id, anchor.coordinate, anchor.requirement]);
          if (searchedContexts.has(contextKey)) continue;
          searchedContexts.add(contextKey);
          candidates = await fetchHotelCandidatesWithFallback(anchor, dates, dayTier, anchor.requirement ?? requirement, isHotelDowngradeAllowed(allowDowngrade, Number(day.day)), fetcher);
          break;
        } catch (error) {
          searchFailure = error;
          if (anchorName === anchorNames.at(-1) || !(error instanceof HotelCandidatesUnavailableError || error instanceof HotelSearchEmptyResultError || error instanceof Error && /未找到.*酒店检索地标/u.test(error.message))) throw error;
        }
      }
      if (!anchor) throw new Error("缺少可定位的酒店检索地标。");
      if (!candidates?.length) throw searchFailure ?? new Error("未取得有效酒店候选。");
    } catch (error) {
      const city = contextCity || anchor?.cityName || "未识别城市";
      const diamond = requirement?.diamond ?? hotelDiamondFromTier(hotelTier);
      const reason = error instanceof Error ? error.message : String(error);
      const failure = `第 ${Number(day.day) || index + 1} 天住宿（检索城市：${city}，要求：${diamond ? `当地${diamond}钻` : hotelTier || "未配置档次"}）未完成：${reason}`;
      if (!onProgress) throw new Error(failure);
      failures.push(failure);
      continue;
    }
    applyHotelCandidates(day, candidates, { anchorName: anchor!.name, cityName: anchor!.cityName, ...requirement, ...anchor!.requirement }, requirement?.diamond ?? hotelDiamondFromTier(hotelTier));
    day.description = text(day.description).replace("入住当地住宿（待匹配）", `入住${candidates[0]!.hotelName}`);
    dailyCandidates.push({ day: Number(day.day), candidates });
    await onProgress?.({ itinerary: structuredClone(nextItinerary), dailyCandidates: structuredClone(dailyCandidates), searchDates: dates });
  }
  if (failures.length) throw new Error(`已取得 ${dailyCandidates.length} 天酒店候选，以下日期仍需核验：\n${failures.join("\n")}`);
  if (!dailyCandidates.length) throw new Error("行程没有需住宿的日期，无法录入酒店候选。");
  return { itinerary: nextItinerary, dailyCandidates, searchDates: dates };
}

/** Injectable provider boundary; production calls preserve the original positional API. */
export function createHotelCandidateResolver(fetcher?: typeof fetch) {
  return (...[itinerary, preferredCity, nights, hotelTier, onProgress, requirements, allowDowngrade, candidatePool]: HotelResolverArgs) =>
    resolveItineraryHotelCandidates(itinerary, preferredCity, nights, hotelTier, onProgress,
      requirements, allowDowngrade, candidatePool, fetcher ?? fetch);
}
type HotelResolverArgs = [
  itinerary: Array<Record<string, unknown>>, preferredCity?: string, nights?: number, hotelTier?: string,
  onProgress?: Parameters<typeof resolveItineraryHotelCandidates>[4], requirements?: Map<number, HotelStayRequirement>,
  allowDowngrade?: boolean | Map<number, boolean>, candidatePool?: CtripHotelCandidate[],
];
export const resolveHotelCandidates = createHotelCandidateResolver();
