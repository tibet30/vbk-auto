import type { TrafficLineEndpointAvailability, TrafficLineEndpointPlan, TrafficLineStation, TrafficLineVariant } from "../../../../shared/contracts-traffic-line.js";
import { searchAirports, searchTrainStations, type StationCandidate } from "../itinerary-api/station-search.js";
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
  /** 初始结构化字段发现允许一类交通候选不确定时，保留另一类已确认结果。 */
  allowPartialAvailabilityOnUncertain?: boolean;
}

type ItineraryDay = { spots?: ItinerarySpot[] };
type ItinerarySpot = { city?: string | null };

/**
 * 大交通端点优先采用运营或用户明确指定的城市；只有该端未指定时才以产品
 * 目的地兜底。首末日景点可能是途经地或酒店所在地，不可再借此推断机场或车站。
 */
export function resolveTrafficLineDestination(product: Record<string, unknown>): { arrivalCity: string; departureCity: string } {
  const basicInfo = product.basicInfo;
  const destinationCity = basicInfo && typeof basicInfo === "object" && !Array.isArray(basicInfo)
    ? normaliseCity((basicInfo as Record<string, unknown>).destinationCity)
    : "";
  const operations = product.operations;
  const trafficLine = operations && typeof operations === "object" && !Array.isArray(operations)
    ? (operations as Record<string, unknown>).trafficLine
    : undefined;
  const configured = trafficLine && typeof trafficLine === "object" && !Array.isArray(trafficLine)
    ? trafficLine as Record<string, unknown>
    : {};
  const arrivalCity = normaliseCity(configured.arrivalCity) || destinationCity;
  const departureCity = normaliseCity(configured.departureCity) || destinationCity;
  if (!arrivalCity || !departureCity) {
    throw new Error("产品缺少已确认的大交通端点和目的地，无法规划交通；未创建任何交通子产品。");
  }
  return { arrivalCity, departureCity };
}

export async function resolveTrafficLineEndpoints(
  page: TrafficLinePage,
  _itinerary: readonly ItineraryDay[],
  now = new Date(),
  disambiguator?: TrafficLineStationDisambiguator,
  product: Record<string, unknown> = {},
  options: TrafficLineEndpointResolutionOptions = {},
): Promise<TrafficLineEndpointPlan> {
  const availability = await preflightTrafficLineEndpoints(
    page, _itinerary, now, disambiguator, product, ["flightRoundTrip", "trainRoundTrip"], options,
  );
  const unavailable = Object.entries(availability.unavailableVariants)
    .map(([variant, reason]) => `${variant === "flightRoundTrip" ? "飞机" : "火车"}：${reason}`);
  if (unavailable.length) throw new Error(`交通站点未能全部确认（${unavailable.join("；")}）。`);
  return availability.endpointPlan;
}

/**
 * 在创建任何子产品前，按交通方式独立查询产品目的地的机场/火车站。
 * 一种方式不可用不会阻断另一种；没有任何可用方式时外层直接跳过交通子产品。
 */
export async function preflightTrafficLineEndpoints(
  page: TrafficLinePage,
  _itinerary: readonly ItineraryDay[],
  now = new Date(),
  disambiguator?: TrafficLineStationDisambiguator,
  product: Record<string, unknown> = {},
  variants: readonly TrafficLineVariant[] = ["flightRoundTrip", "trainRoundTrip"],
  options: TrafficLineEndpointResolutionOptions = {},
): Promise<TrafficLineEndpointAvailability> {
  const { arrivalCity, departureCity } = resolveTrafficLineDestination(product);
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
      if (!isUnavailableTrafficStation(reason) && !options.allowPartialAvailabilityOnUncertain) throw error;
      unavailableVariants[variant] = reason;
    }
  }));
  const stableAvailableVariants = [...new Set(variants)].filter((variant) => availableVariants.includes(variant));
  return { endpointPlan, availableVariants: stableAvailableVariants, unavailableVariants };
}

function isUnavailableTrafficStation(reason: string): boolean {
  return /未找到唯一可确认的(?:机场|火车站)候选/.test(reason);
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
