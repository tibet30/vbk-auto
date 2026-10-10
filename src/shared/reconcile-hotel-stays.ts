import { hotelCandidateMeetsStay, hotelStayRequirement } from "./hotel-stay-requirement.js";
import { normaliseReturnDayLodging } from "./itinerary-hotel.js";
type Json = Record<string, unknown>;
const object = (value: unknown): Json => value && typeof value === "object" && !Array.isArray(value) ? value as Json : {};

/** 每次产品写入都对照用户住宿地点，缓存与模型不能把被撤回的异地候选加回。 */
export function reconcileHotelStays(product: Json): Json {
  const next = structuredClone(product);
  if (!Array.isArray(next.itinerary)) return next;
  const affected = new Set<number>();
  next.itinerary = next.itinerary.map(value => {
    const day = normaliseReturnDayLodging(object(value), object(next.basicInfo));
    const requirement = hotelStayRequirement(next, day);
    if (!requirement) return day;
    const candidates = Array.isArray(day.hotelCandidates) ? day.hotelCandidates.map(object) : [];
    const valid = candidates.filter(candidate => hotelCandidateMeetsStay(candidate, requirement));
    const result: Json = { ...day, hotelRequirement: requirement };
    if (valid.length !== candidates.length) {
      affected.add(Number(day.day));
      result.hotelCandidates = valid;
      if (!valid.some(candidate => candidate.hotelName === day.hotel)) {
        result.hotel = valid[0]?.hotelName || `${requirement.cityName || ""}${requirement.anchorName}附近住宿（待核验）`;
        result.hotelDescription = valid.length ? `入住${result.hotel}` : `${requirement.anchorName}附近住宿待核验；不接受超出原定地点的酒店。`;
      }
    }
    return result;
  });
  // An operator may already have removed invalid itinerary candidates while
  // the resource mirror still carries them. Check that mirror independently.
  const cached = object(object(next.operations).hotelResource).dailyCandidates;
  for (const entry of Array.isArray(cached) ? cached.map(object) : []) {
    const day = (next.itinerary as unknown[]).map(object).find(day => Number(day.day) === Number(entry.day));
    const requirement = day && hotelStayRequirement(next, day);
    if (requirement && Array.isArray(entry.candidates)
      && entry.candidates.map(object).some(candidate => !hotelCandidateMeetsStay(candidate, requirement))) affected.add(Number(entry.day));
  }
  if (affected.size) {
    const operations = object(next.operations);
    const resource = object(operations.hotelResource);
    const days = (next.itinerary as unknown[]).map(object);
    const dailyCandidates = days.filter(day => Array.isArray(day.hotelCandidates) && day.hotelCandidates.length)
      .map(day => ({ day: day.day, candidates: day.hotelCandidates as Json[] }));
    const first = dailyCandidates[0]?.candidates[0];
    operations.hotelResource = first ? { ...resource, resourceId: first.hotelId, resourceName: first.hotelName,
      diamond: first.diamond, candidates: dailyCandidates[0]!.candidates, dailyCandidates } : {};
    next.operations = operations;
  }
  return next;
}
