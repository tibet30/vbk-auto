import type { resolveItineraryHotelCandidates } from "../infrastructure/ctrip-hotel-search.js";

/** Resolver receipt retained for recovery and visible to the Agent after local persistence. */
export function persistedItineraryHotelResult(resolved: Awaited<ReturnType<typeof resolveItineraryHotelCandidates>>) {
  return {
    persisted: true, persistedPath: "itinerary[].hotelCandidates",
    persistenceNote: "酒店候选已自动写回本地行程，无需再调用 patch_product 更新 itinerary。",
    dailyCandidates: resolved.dailyCandidates, searchDates: resolved.searchDates,
    persistedDays: resolved.dailyCandidates.map(({ day, candidates }) => {
      const row = resolved.itinerary.find((value) => Number(value.day) === day);
      const selected = candidates[0];
      return { day, hotel: String(row?.hotel ?? ""), candidateCount: candidates.length,
        selectedHotel: selected && { hotelId: selected.hotelId, hotelName: selected.hotelName, diamond: selected.diamond, cityName: selected.cityName } };
    }),
  };
}
