/** Canonical pickup/dropoff station resolution for itinerary writes and preflight. */

import { searchAirports, searchTrainStations, type StationCandidate } from "./station-search.js";
import type { ResolvedStations } from "./itinerary-transform.js";

type StationKind = "airport" | "train";
type VerifiedStation = { code: string; name: string };

export interface ItineraryStationResolutionInput {
  pickupCity: string;
  /** Used only when no verified departure endpoint is available. */
  dropoffCity?: string;
  endpointPlan?: unknown;
}

interface VerifiedEndpointPlan {
  arrivalCity: string;
  departureCity: string;
  flight?: { arrival: VerifiedStation; departure: VerifiedStation };
  train?: { arrival: VerifiedStation; departure: VerifiedStation };
}

function station(value: unknown): VerifiedStation | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const code = typeof raw.code === "string" ? raw.code.trim() : "";
  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  return code && name ? { code, name } : undefined;
}

function pair(value: unknown): { arrival: VerifiedStation; departure: VerifiedStation } | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const arrival = station(raw.arrival);
  const departure = station(raw.departure);
  return arrival && departure ? { arrival, departure } : undefined;
}

function verifiedPlan(value: unknown): VerifiedEndpointPlan | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const arrivalCity = typeof raw.arrivalCity === "string" ? raw.arrivalCity.trim() : "";
  const departureCity = typeof raw.departureCity === "string" ? raw.departureCity.trim() : "";
  if (!arrivalCity || !departureCity) return undefined;
  const flight = pair(raw.flight);
  const train = pair(raw.train);
  return { arrivalCity, departureCity, ...(flight ? { flight } : {}), ...(train ? { train } : {}) };
}

/** City-only fallback: candidate name must explicitly name the queried city. */
export function pickAirport(candidates: StationCandidate[], city: string): StationCandidate | null {
  const trimmed = city.trim();
  return candidates.find((candidate) => candidate.name === trimmed)
    ?? candidates.find((candidate) => candidate.name.includes(trimmed))
    ?? null;
}

/** City-only fallback: candidate name must explicitly name the queried city. */
export function pickTrain(candidates: StationCandidate[], city: string): StationCandidate | null {
  return pickAirport(candidates, city);
}

function candidateList(candidates: StationCandidate[]): string {
  return candidates.length
    ? candidates.slice(0, 8).map((candidate) => `${candidate.name}（${candidate.code}）`).join("、")
    : "无";
}

function exactVerifiedCandidate(candidates: StationCandidate[], endpoint: VerifiedStation, kind: StationKind): StationCandidate {
  const match = candidates.find((candidate) => candidate.code === endpoint.code && candidate.name === endpoint.name);
  if (match) return match;
  const label = kind === "airport" ? "机场" : "火车站";
  throw new Error(`已核验${label}端点 ${endpoint.name}（${endpoint.code}）重新查询后不一致；当前候选：${candidateList(candidates)}。拒绝改用其它站点。`);
}

function cachedSearch(page: Parameters<typeof searchAirports>[0]) {
  const cached = new Map<string, Promise<StationCandidate[]>>();
  return (kind: StationKind, keyword: string) => {
    const key = `${kind}:${keyword}`;
    const existing = cached.get(key);
    if (existing) return existing;
    const request = kind === "airport" ? searchAirports(page, keyword) : searchTrainStations(page, keyword);
    cached.set(key, request);
    return request;
  };
}

async function resolveOne(
  search: (kind: StationKind, keyword: string) => Promise<StationCandidate[]>,
  kind: StationKind,
  city: string,
  endpoint: VerifiedStation | undefined,
): Promise<StationCandidate | null> {
  if (endpoint) return exactVerifiedCandidate(await search(kind, endpoint.name), endpoint, kind);
  const candidates = await search(kind, city);
  return kind === "airport" ? pickAirport(candidates, city) : pickTrain(candidates, city);
}

/** Pickup follows plan.arrival and dropoff follows plan.departure when verified. */
export async function resolveStationsForItinerary(
  page: Parameters<typeof searchAirports>[0],
  input: ItineraryStationResolutionInput,
): Promise<ResolvedStations> {
  const fallbackPickupCity = input.pickupCity.trim();
  if (!fallbackPickupCity) throw new Error("接送站搜索城市为空");
  const plan = verifiedPlan(input.endpointPlan);
  const pickupCity = plan?.arrivalCity ?? fallbackPickupCity;
  const dropoffCity = plan?.departureCity || input.dropoffCity?.trim() || fallbackPickupCity;
  const search = cachedSearch(page);
  const [pickupAir, pickupTrain, dropoffAir, dropoffTrain] = await Promise.all([
    resolveOne(search, "airport", pickupCity, plan?.flight?.arrival),
    resolveOne(search, "train", pickupCity, plan?.train?.arrival),
    resolveOne(search, "airport", dropoffCity, plan?.flight?.departure),
    resolveOne(search, "train", dropoffCity, plan?.train?.departure),
  ]);
  return { pickupAir, pickupTrain, dropoffAir, dropoffTrain };
}

/** Compatibility entrypoint for callers that only have one city. */
export async function resolveStationsForCity(
  page: Parameters<typeof searchAirports>[0],
  city: string,
  endpointPlan?: unknown,
): Promise<ResolvedStations> {
  return resolveStationsForItinerary(page, { pickupCity: city, endpointPlan });
}
