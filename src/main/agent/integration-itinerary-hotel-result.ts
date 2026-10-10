import type { resolveItineraryHotelCandidates } from "../infrastructure/ctrip-hotel-search.js";
import { reconcileResolvedHotelCopy } from "./hotel-candidate-recovery.js";
import { isDeepStrictEqual } from "node:util";

type Json = Record<string, unknown>;
type HotelResult = Awaited<ReturnType<typeof resolveItineraryHotelCandidates>>;

/** 更新本次已核验的酒店字段，保留查询期间的景点、餐食和其他人工修改。 */
export function mergeResolvedHotelProgress(product: Json, initial: Json[], resolved: HotelResult): Json {
  const itinerary = Array.isArray(product.itinerary) ? product.itinerary as Json[] : [];
  const daily = resolved.dailyCandidates;
  const next = itinerary.map((day) => {
    const match = daily.find((entry) => entry.day === Number(day.day));
    if (!match) return day;
    const original = initial.find((entry) => Number(entry.day) === match.day);
    const hotel = String(day.hotel ?? "");
    if (hotel !== String(original?.hotel ?? "") && !match.candidates.some((candidate) => candidate.hotelName === hotel)) {
      throw new Error(`第 ${match.day} 天住宿在查询期间已改变，请按当前住宿重新核验。`);
    }
    const source = resolved.itinerary.find((entry) => Number(entry.day) === match.day)!;
    if (!isDeepStrictEqual(day.hotelRequirement, original?.hotelRequirement)
      && !isDeepStrictEqual(day.hotelRequirement, source.hotelRequirement)) {
      throw new Error(`第 ${match.day} 天住宿地点或评级在查询期间已改变，请按当前要求重新核验。`);
    }
    return reconcileResolvedHotelCopy({ ...day, hotel: source.hotel, hotelDescription: source.hotelDescription,
      ...(source.hotelRequirement ? { hotelRequirement: source.hotelRequirement } : {}), hotelCandidates: match.candidates });
  });
  const first = daily[0]?.candidates[0];
  if (!first) return product;
  const operations = product.operations as Json | undefined;
  return { ...product, itinerary: next, operations: { ...operations, hotelResource: {
    source: "ctrip", resourceId: first.hotelId, resourceName: first.hotelName, diamond: first.diamond,
    candidates: daily[0]!.candidates, dailyCandidates: daily,
  } } };
}

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
