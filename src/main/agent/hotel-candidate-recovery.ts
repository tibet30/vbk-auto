import type { AgentSnapshot } from "../../shared/contracts.js";

type Json = Record<string, unknown>;
type Candidate = { hotelId: number; hotelName: string; diamond: number; score: number; distanceKm: number; cityName: string; anchorName: string; anchorCityId: number; address?: string };
type DailyCandidates = { day: number; candidates: Candidate[] };

function record(value: unknown): value is Json { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function text(value: unknown): string { return typeof value === "string" ? value.trim() : ""; }

function candidate(value: unknown): Candidate | null {
  if (!record(value)) return null;
  const hotelId = Number(value.hotelId); const diamond = Number(value.diamond); const score = Number(value.score);
  const distanceKm = Number(value.distanceKm); const anchorCityId = Number(value.anchorCityId);
  if (!Number.isInteger(hotelId) || hotelId <= 0 || !Number.isInteger(diamond) || diamond < 1 || diamond > 5
    || !Number.isFinite(score) || score < 0 || !Number.isFinite(distanceKm) || distanceKm < 0
    || !Number.isInteger(anchorCityId) || anchorCityId <= 0 || !text(value.hotelName) || !text(value.cityName) || !text(value.anchorName)) return null;
  return { hotelId, hotelName: text(value.hotelName), diamond, score, distanceKm, cityName: text(value.cityName), anchorName: text(value.anchorName), anchorCityId, ...(text(value.address) ? { address: text(value.address) } : {}) };
}

function resolvedDailyCandidates(snapshot: AgentSnapshot): DailyCandidates[] | null {
  const calls = new Set(snapshot.events.filter((event) => event.type === "tool_call" && event.data?.name === "resolve_itinerary_hotels")
    .map((event) => String(event.data?.toolCallId ?? "")).filter(Boolean));
  for (const event of [...snapshot.events].reverse()) {
    if (event.type !== "tool_result" || !calls.has(String(event.data?.toolCallId ?? ""))) continue;
    try {
      const parsed = JSON.parse(event.content) as Json;
      if (!Array.isArray(parsed.dailyCandidates)) continue;
      const daily = parsed.dailyCandidates.flatMap((entry): DailyCandidates[] => {
        if (!record(entry) || !Number.isInteger(Number(entry.day)) || Number(entry.day) <= 0 || !Array.isArray(entry.candidates)) return [];
        const candidates = entry.candidates.map(candidate).filter((item): item is Candidate => Boolean(item));
        return candidates.length === entry.candidates.length && candidates.length ? [{ day: Number(entry.day), candidates }] : [];
      });
      if (daily.length && daily.length === parsed.dailyCandidates.length) return daily;
    } catch { /* Malformed history is never recovery evidence. */ }
  }
  return null;
}

/** Restore only a durable resolver result that still exactly matches the current selected hotel. */
export function recoverResolvedHotelCandidates(product: Json, snapshot: AgentSnapshot): Json | null {
  const daily = resolvedDailyCandidates(snapshot);
  const itinerary = Array.isArray(product.itinerary) ? product.itinerary.filter(record) : [];
  if (!daily || !itinerary.length || daily.some(({ day, candidates }) => {
    const current = itinerary.find((item) => Number(item.day) === day);
    return !current || Array.isArray(current.hotelCandidates) || text(current.hotel) !== candidates[0]?.hotelName;
  })) return null;
  const nextItinerary = itinerary.map((day) => {
    const match = daily.find((entry) => entry.day === Number(day.day));
    return match ? { ...day, hotelCandidates: match.candidates } : structuredClone(day);
  });
  const first = daily[0]!.candidates[0]!;
  const operations = record(product.operations) ? product.operations : {};
  return { ...structuredClone(product), itinerary: nextItinerary, operations: { ...operations, hotelResource: {
    source: "ctrip", resourceId: first.hotelId, resourceName: first.hotelName, diamond: first.diamond,
    candidates: daily[0]!.candidates, dailyCandidates: daily,
  } } };
}
