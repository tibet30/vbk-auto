import type { TrafficLineEndpointPlan, TrafficLineStation, TrafficLineVariant } from "../../../../shared/contracts-traffic-line.js";
import { searchAirports, searchTrainStations, type StationCandidate } from "../itinerary-api/station-search.js";
import { suggestPoiDetail } from "../../../infrastructure/poi-suggest.js";
import type { TrafficLinePage } from "./client.js";

export type TrafficLineStationDisambiguator = (request: {
  kind: "station";
  stationSubtype: "airport" | "train";
  desired: string;
  candidates: Array<{ id?: string; text: string }>;
  product: Record<string, unknown>;
}) => Promise<{ pickedText: string | null; reasoning: string }>;

export interface TrafficLineEndpointResolutionOptions {
  /** 已被正式资源校验证实不可用的火车站码；恢复时不得再次选择。 */
  excludedTrainCodes?: readonly string[];
}

export interface TrafficLineEndpointAvailability {
  endpointPlan: TrafficLineEndpointPlan;
  availableVariants: TrafficLineVariant[];
  unavailableVariants: Partial<Record<TrafficLineVariant, string>>;
}

type ItinerarySpot = {
  name?: string | null;
  poiName?: string | null;
  poiId?: number | null;
  city?: string | null;
};
type ItineraryDay = { spots?: ItinerarySpot[] };
type PoiCityCandidate = { poiId: number | null; city: string | null };
type PoiCityLookup = (spot: ItinerarySpot) => Promise<readonly PoiCityCandidate[]>;

/**
 * 只接受行程首日/末日 POI 已解析的 city。目的地、接送城市和景点名称都不能
 * 作为兜底，避免把“途经/景区”误当成机场或车站所在地。
 */
export function deriveTrafficLineCities(itinerary: readonly ItineraryDay[]): { arrivalCity: string; departureCity: string } {
  const first = itinerary[0];
  const last = itinerary.at(-1);
  const arrivalCity = explicitPoiCity(first?.spots, "首日");
  const departureCity = explicitPoiCity(last?.spots, "末日");
  return { arrivalCity, departureCity };
}

export async function resolveTrafficLineEndpoints(
  page: TrafficLinePage,
  itinerary: readonly ItineraryDay[],
  now = new Date(),
  disambiguator?: TrafficLineStationDisambiguator,
  product: Record<string, unknown> = { itinerary },
  options: TrafficLineEndpointResolutionOptions = {},
): Promise<TrafficLineEndpointPlan> {
  const availability = await preflightTrafficLineEndpoints(
    page, itinerary, now, disambiguator, product, ["flightRoundTrip", "trainRoundTrip"], options,
  );
  const unavailable = Object.entries(availability.unavailableVariants)
    .map(([variant, reason]) => `${variant === "flightRoundTrip" ? "飞机" : "火车"}：${reason}`);
  if (unavailable.length) throw new Error(`交通站点未能全部确认（${unavailable.join("；")}）。`);
  return availability.endpointPlan;
}

/**
 * 在创建任何子产品前，按交通方式独立查询首末日城市的机场/火车站。
 * 一种方式不可用不会阻断另一种；没有任何可用方式时外层直接跳过交通子产品。
 */
export async function preflightTrafficLineEndpoints(
  page: TrafficLinePage,
  itinerary: readonly ItineraryDay[],
  now = new Date(),
  disambiguator?: TrafficLineStationDisambiguator,
  product: Record<string, unknown> = { itinerary },
  variants: readonly TrafficLineVariant[] = ["flightRoundTrip", "trainRoundTrip"],
  options: TrafficLineEndpointResolutionOptions = {},
): Promise<TrafficLineEndpointAvailability> {
  const { arrivalCity, departureCity } = await resolveTrafficLineCities(page, itinerary);
  const sameCity = arrivalCity === departureCity;
  const endpointPlan: TrafficLineEndpointPlan = { arrivalCity, departureCity, resolvedAt: now.toISOString() };
  const availableVariants: TrafficLineVariant[] = [];
  const unavailableVariants: Partial<Record<TrafficLineVariant, string>> = {};
  await Promise.all([...new Set(variants)].map(async (variant) => {
    const kind = variant === "flightRoundTrip" ? "airport" : "train";
    try {
      const arrival = await resolveUniqueStation(
        page, kind, arrivalCity, disambiguator, product,
        variant === "trainRoundTrip" ? options.excludedTrainCodes : [],
      );
      const departure = sameCity ? arrival : await resolveUniqueStation(
        page, kind, departureCity, disambiguator, product,
        variant === "trainRoundTrip" ? options.excludedTrainCodes : [],
      );
      if (variant === "flightRoundTrip") endpointPlan.flight = { arrival: toStation(arrival), departure: toStation(departure) };
      else endpointPlan.train = { arrival: toStation(arrival), departure: toStation(departure) };
      availableVariants.push(variant);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      // 「没有站点」才是跳过该交通方式的业务结论；会话、接口、候选歧义等
      // 不确定状态必须显式中断，不能伪装成目的地没有交通。
      if (!isUnavailableTrafficStation(reason)) throw error;
      unavailableVariants[variant] = reason;
    }
  }));
  return { endpointPlan, availableVariants, unavailableVariants };
}

function isUnavailableTrafficStation(reason: string): boolean {
  return /未找到唯一可确认的(?:机场|火车站)候选/.test(reason);
}

/**
 * 新规划直接使用已落库 city；历史行程缺 city 时，按已确认 poiId 通过当前会话
 * 回查 VBK POI 候选。接口没有唯一确认每个 POI 所属城市时禁止继续。
 */
export async function resolveTrafficLineCities(
  page: TrafficLinePage,
  itinerary: readonly ItineraryDay[],
  lookup: PoiCityLookup = (spot) => lookupPoiCities(page, spot),
): Promise<{ arrivalCity: string; departureCity: string }> {
  const first = itinerary[0];
  const last = itinerary.at(-1);
  return {
    arrivalCity: await explicitOrVerifiedPoiCity(first?.spots, "首日", lookup),
    departureCity: await explicitOrVerifiedPoiCity(last?.spots, "末日", lookup),
  };
}

async function resolveUniqueStation(
  page: TrafficLinePage,
  kind: "airport" | "train",
  city: string,
  disambiguator: TrafficLineStationDisambiguator | undefined,
  product: Record<string, unknown>,
  excludedTrainCodes: readonly string[] = [],
): Promise<StationCandidate> {
  const rawCandidates = kind === "airport"
    ? await searchAirports(page, city)
    : await searchTrainStations(page, city);
  const excluded = new Set(excludedTrainCodes.map((code) => code.trim()).filter(Boolean));
  const candidates = kind === "train"
    ? domesticTrainCandidates(rawCandidates).filter((candidate) => !excluded.has(candidate.code))
    : rawCandidates;
  const unique = trySelectUniqueTrafficLineStation(candidates, city, kind);
  if (unique) return unique;
  if (!candidates.length) return selectUniqueTrafficLineStation(candidates, city, kind);
  if (!disambiguator) {
    throw new Error(`${city}返回${candidates.length}个${kind === "airport" ? "机场" : "火车站"}候选，但当前缺少安全消歧器；未创建任何交通子产品，可安全重试。`);
  }
  const picked = await disambiguator({
    kind: "station",
    stationSubtype: kind,
    // 多火车站城市要规划当前主要客运/高铁枢纽，而不是按文本相似度机械选
    // 与城市同名、却可能已停运或班次稀少的老站。
    desired: kind === "train" ? `${city}主要客运火车站` : city,
    candidates: candidates.map((candidate) => ({ id: candidate.code, text: candidate.name })),
    product: kind === "train" ? { ...product, itineraryCity: city, stationSelectionGoal: "主要客运或高铁枢纽" } : product,
  });
  const matches = candidates.filter((candidate) => candidate.name === picked.pickedText);
  if (matches.length === 1) return matches[0]!;
  throw new Error(`${city}的${kind === "airport" ? "机场" : "火车站"}候选未被安全消歧；未创建任何交通子产品，可安全重试。`);
}

function domesticTrainCandidates(candidates: readonly StationCandidate[]): StationCandidate[] {
  const domestic = candidates.filter((candidate) => candidate.code.startsWith("CN"));
  return domestic.length ? domestic : [...candidates];
}

function trySelectUniqueTrafficLineStation(
  candidates: readonly StationCandidate[],
  _city: string,
  _kind: "airport" | "train",
): StationCandidate | null {
  if (candidates.length === 1) return candidates[0]!;
  // 多站城市的同名老站并不等于当前主客运站（例如「成都」与「成都东」）。
  // 只要候选超过一个，就必须经过当前会话的安全消歧器，不能走同名捷径。
  return null;
}

/** 仅唯一的规范化城市匹配可以胜出；禁止沿用行程模块的“首项兜底”。 */
export function selectUniqueTrafficLineStation(
  candidates: readonly StationCandidate[],
  city: string,
  kind: "airport" | "train",
): StationCandidate {
  const matches = candidates.filter((candidate) => stationMatchesCity(candidate, city, kind));
  if (matches.length === 1) return matches[0]!;
  const kindLabel = kind === "airport" ? "机场" : "火车站";
  if (!matches.length) {
    throw new Error(`${city}未找到唯一可确认的${kindLabel}候选；未创建任何交通子产品，可在会话恢复或补全 POI 城市后安全重试。`);
  }
  throw new Error(`${city}返回${matches.length}个可匹配${kindLabel}候选；不会按列表首项猜测，请人工消歧后安全重试。`);
}

function explicitPoiCity(spots: ItineraryDay["spots"], dayLabel: string): string {
  const cities = [...new Set((spots ?? []).map((spot) => normaliseCity(spot.city)).filter(Boolean))];
  if (cities.length !== 1) {
    throw new Error(`${dayLabel}行程缺少唯一的 POI 城市，无法规划抵达/返程交通；未创建任何交通子产品。`);
  }
  return cities[0]!;
}

async function explicitOrVerifiedPoiCity(
  spots: ItineraryDay["spots"],
  dayLabel: string,
  lookup: PoiCityLookup,
): Promise<string> {
  const stored = [...new Set((spots ?? []).map((spot) => normaliseCity(spot.city)).filter(Boolean))];
  if (stored.length === 1) return stored[0]!;
  if (stored.length > 1) throw new Error(`${dayLabel}行程存在多个 POI 城市，无法唯一规划交通。`);
  if (!spots?.length) throw new Error(`${dayLabel}行程没有可回查城市的 POI，无法规划交通。`);
  const verified: string[] = [];
  for (const spot of spots) {
    const poiId = Number(spot.poiId);
    const keyword = String(spot.poiName || spot.name || "").trim();
    if (!Number.isInteger(poiId) || poiId <= 0 || !keyword) {
      throw new Error(`${dayLabel}行程 POI 缺少已确认的 poiId/名称，无法通过接口核实城市。`);
    }
    const candidates = (await lookup(spot)).filter((candidate) => candidate.poiId === poiId);
    if (candidates.length !== 1) {
      throw new Error(`${dayLabel}行程 POI「${keyword}」未由 VBK 接口唯一确认，无法规划交通。`);
    }
    const city = normaliseCity(candidates[0]?.city);
    if (!city) throw new Error(`${dayLabel}行程 POI「${keyword}」的 VBK 候选缺少城市，无法规划交通。`);
    verified.push(city);
  }
  const cities = [...new Set(verified)];
  if (cities.length !== 1) throw new Error(`${dayLabel}行程 POI 接口回查得到多个城市（${cities.join("、")}），无法唯一规划交通。`);
  return cities[0]!;
}

async function lookupPoiCities(page: TrafficLinePage, spot: ItinerarySpot): Promise<readonly PoiCityCandidate[]> {
  const keyword = String(spot.poiName || spot.name || "").trim();
  const detail = await suggestPoiDetail(page, keyword);
  return detail.candidates.map((candidate) => ({ poiId: candidate.poiId, city: candidate.city ?? null }));
}

function stationMatchesCity(candidate: StationCandidate, city: string, kind: "airport" | "train"): boolean {
  const normalizedCity = normaliseCity(city);
  const name = normaliseStationName(candidate.name);
  if (kind === "airport") return name.includes(normalizedCity) && /机场$/.test(name);
  return name === normalizedCity || name === `${normalizedCity}站`;
}

function normaliseCity(value: unknown): string {
  return typeof value === "string" ? value.trim().replace(/\s+/g, "").replace(/市$/, "") : "";
}

function normaliseStationName(value: string): string {
  return value.trim().replace(/\s+/g, "").replace(/市(?=机场|站)/, "");
}

function toStation(candidate: StationCandidate): TrafficLineStation {
  if (candidate.type !== "train") return { code: candidate.code, name: candidate.name };
  const stationNo = Number((candidate.raw as Record<string, unknown>).stationNo);
  if (!Number.isInteger(stationNo) || stationNo <= 0) {
    throw new Error(`${candidate.name}火车站候选缺少有效 stationNo，未创建任何交通子产品。`);
  }
  return { code: candidate.code, name: candidate.name, resourceKey: String(stationNo) };
}
