import { HOTEL_RESOURCE_CANDIDATE_COUNT, HOTEL_RESOURCE_MIN_CANDIDATE_COUNT } from "../../../shared/hotel-candidate-counts.js";
import { hasItineraryHotelStay } from "../../../shared/itinerary-hotel.js";
import { hotelResourceGroups } from "./hotel-resource-api.js";
import { getProductSegmentsApi, segmentsFromPayload } from "./vehicle-resource-api.js";

type Json = Record<string, any>;

/**
 * Verifies an already-persisted hotel binding without repairing drafts, adding
 * resource segments, or saving any hotel. This is the only hotel check safe to
 * use from a read-only recovery flow.
 */
export async function verifyHotelResourceReadback(page: any, product: any, productId: string) {
  const itineraryDays = Array.isArray(product?.itinerary) ? product.itinerary : [];
  const days = itineraryDays.filter((day: any) => hasItineraryHotelStay(day?.hotel));
  if (!days.length) return { skipped: "行程不含住宿", verified: true };
  const source = product?.operations?.hotelResource?.source === "ctrip"
    || days.every((day: any) => Array.isArray(day.hotelCandidates) && day.hotelCandidates.length > 0)
    ? "ctrip" : "package-api";
  const expected = hotelGroups(days, source);
  const segments = segmentsFromPayload(await getProductSegmentsApi(page, productId));
  const lodging = segments.slice(1).filter((segment: Json) => Number(segment.segmentBase?.stayNights) > 0);
  if (lodging.length !== expected.length) {
    throw new Error(`酒店资源只读回读住宿段数量不一致：期望 ${expected.length}，实际 ${lodging.length}`);
  }
  const verified = lodging.map((segment: Json, index: number) => {
    const wanted = expected[index]!;
    const base = segment.segmentBase ?? {};
    const city = String(base.destinationCity?.cityName ?? "").trim();
    if (city !== wanted.cityName || Number(base.stayNights) !== wanted.nights
      || Number(base.minStayNights) !== wanted.nights || Number(base.maxStayNights) !== wanted.nights) {
      throw new Error(`酒店资源只读回读第 ${index + 1} 段城市或住宿晚数不一致。`);
    }
    const rawRooms = Array.isArray(segment?.hotel?.segmentRooms) ? segment.hotel.segmentRooms : [];
    const actualIds: number[] = source === "ctrip"
      ? rawRooms.map((room: unknown) => room && typeof room === "object"
        ? Number((room as Json).masterHotelID ?? (room as Json).hotelID)
        : Number.NaN)
      : rooms(segment).map((room) => Number(room.masterHotelID ?? room.hotelID));
    if (source === "ctrip") {
      const validCount = actualIds.length >= HOTEL_RESOURCE_MIN_CANDIDATE_COUNT
        && actualIds.length <= HOTEL_RESOURCE_CANDIDATE_COUNT
        && actualIds.length === wanted.hotelIds.length;
      const validIds = actualIds.every((id) => Number.isSafeInteger(id) && id > 0);
      const uniqueIds = new Set(actualIds).size === actualIds.length;
      const expectedIds = new Set(wanted.hotelIds);
      const sameIdSet = validIds && uniqueIds && actualIds.every((id) => expectedIds.has(id));
      if (!validCount || !validIds || !uniqueIds || !sameIdSet) {
        throw new Error(`酒店资源只读回读第 ${index + 1} 段候选 ID 集合不一致：期望=${wanted.hotelIds.join(",")}，实际=${actualIds.join(",")}`);
      }
    }
    return {
      segmentId: String(segment.segmentId),
      cityName: city,
      nights: wanted.nights,
      dayNumbers: wanted.dayNumbers,
      candidateCount: actualIds.length,
      hotelIds: actualIds,
    };
  });
  return {
    source,
    verified: true,
    positiveSegmentCount: verified.length,
    segments: verified,
    dailyCandidateCounts: itineraryDays.map((day: any) => ({
      day: Number(day.day),
      candidateCount: hasItineraryHotelStay(day?.hotel) && Array.isArray(day.hotelCandidates) ? day.hotelCandidates.length : 0,
    })),
  };
}

function hotelGroups(days: Json[], source: "ctrip" | "package-api") {
  const groups = hotelResourceGroups(days, source === "ctrip").map(({ cityName, nights, dayNumbers, hotelIds }) => ({
    cityName,
    nights,
    dayNumbers,
    hotelIds: source === "ctrip" ? hotelIds : [],
  }));
  for (const day of days) {
    const candidates = Array.isArray(day.hotelCandidates) ? day.hotelCandidates : [];
    if (source === "ctrip") {
      if (candidates.length < HOTEL_RESOURCE_MIN_CANDIDATE_COUNT || candidates.length > HOTEL_RESOURCE_CANDIDATE_COUNT) {
        throw new Error(`酒店资源缺少每晚至少 ${HOTEL_RESOURCE_MIN_CANDIDATE_COUNT} 个且最多 ${HOTEL_RESOURCE_CANDIDATE_COUNT} 个携程候选：第 ${day.day}`);
      }
    }
    const hotelIds = source === "ctrip" ? candidates.map((candidate: Json) => Number(candidate.hotelId)) : [];
    if (source === "ctrip" && (hotelIds.some((id) => !Number.isInteger(id) || id <= 0) || new Set(hotelIds).size !== hotelIds.length)) {
      throw new Error(`第 ${day.day} 天酒店候选 ID 无效或重复。`);
    }
  }
  return groups;
}

function rooms(segment: Json): Json[] {
  return Array.isArray(segment?.hotel?.segmentRooms)
    ? segment.hotel.segmentRooms.filter((room: unknown): room is Json => Boolean(room) && typeof room === "object")
    : [];
}
