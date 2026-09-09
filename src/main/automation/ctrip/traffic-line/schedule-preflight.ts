import { pinyin } from "pinyin-pro";
import type {
  TrafficLineEndpointAvailability,
  TrafficLineScheduleCheck,
  TrafficLineVariant,
} from "../../../../shared/contracts-traffic-line.js";
import { searchAirports, type StationCandidate } from "../itinerary-api/station-search.js";
import { postTrafficLineSoa, text, type JsonRecord, type TrafficLinePage } from "./client.js";
import { selectTrafficLineValidationCities, trafficLineResourceCheckDates } from "./segments.js";

const PREFLIGHT_CITY_LIMIT = 12;
const PREFERRED_GATEWAY_CITIES = ["北京", "上海", "广州", "成都", "重庆", "西安", "昆明", "拉萨"];

export interface TrafficLineSchedulePreflightDependencies {
  loadCityGroups?: () => Promise<JsonRecord[]>;
  searchOriginAirports?: (cityName: string) => Promise<StationCandidate[]>;
  fetchHtml?: (url: string, label: string) => Promise<string>;
}

/** 在本地产品准备阶段查询代表日期班次，只让明确通过的交通方式进入创建计划。 */
export async function preflightTrafficLineSchedules(args: {
  page: TrafficLinePage;
  availability: TrafficLineEndpointAvailability;
  product: Record<string, unknown>;
  now?: Date;
  dependencies?: TrafficLineSchedulePreflightDependencies;
}): Promise<TrafficLineEndpointAvailability> {
  const dates = trafficLineResourceCheckDates(args.product, args.now);
  if (!dates.length) throw new Error("大交通前置校验缺少可用的产品班期。");
  const groups = await (args.dependencies?.loadCityGroups?.() ?? loadCityGroups(args.page));
  const scheduleChecks: Partial<Record<TrafficLineVariant, TrafficLineScheduleCheck>> = {};
  const availableVariants: TrafficLineVariant[] = [];
  const unavailableVariants = { ...args.availability.unavailableVariants };

  await Promise.all(args.availability.availableVariants.map(async (variant) => {
    const cities = rankGatewayCities(selectTrafficLineValidationCities(groups, variant, {
      cityId: "", cityName: args.availability.endpointPlan.arrivalCity,
    }))
      .slice(0, PREFLIGHT_CITY_LIMIT);
    const result = await probeVariant({ ...args, variant, dates, cities });
    scheduleChecks[variant] = result;
    if (result.status === "available") availableVariants.push(variant);
    else unavailableVariants[variant] = result.reason;
  }));

  const ordered = args.availability.availableVariants.filter((variant) => availableVariants.includes(variant));
  return { ...args.availability, availableVariants: ordered, unavailableVariants, scheduleChecks };
}

async function probeVariant(args: {
  page: TrafficLinePage;
  availability: TrafficLineEndpointAvailability;
  product: Record<string, unknown>;
  variant: TrafficLineVariant;
  dates: string[];
  cities: JsonRecord[];
  dependencies?: TrafficLineSchedulePreflightDependencies;
}): Promise<TrafficLineScheduleCheck> {
  if (!args.cities.length) return checkResult("unavailable", args, "VBK 热门城市中没有对应交通能力的出发城市。");
  let uncertainReason = "";
  for (const batch of chunks(args.cities, 4)) {
    const results = await Promise.all(batch.map(async (city) => {
      try {
        return await cityHasRoundTrip(args, text(city.cityName));
      } catch (error) {
        uncertainReason ||= error instanceof Error ? error.message : String(error);
        return false;
      }
    }));
    const matchedIndex = results.findIndex(Boolean);
    if (matchedIndex >= 0) {
      return {
        ...checkResult("available", args),
        matchedOriginCity: text(batch[matchedIndex]?.cityName),
      };
    }
  }
  if (uncertainReason) return checkResult("unconfirmed", args, `部分班次查询未确认：${uncertainReason}`);
  return checkResult("unavailable", args, "代表日期内未找到可往返的携程班次。");
}

async function cityHasRoundTrip(args: Parameters<typeof probeVariant>[0], cityName: string): Promise<boolean> {
  if (args.variant === "trainRoundTrip") {
    return allTrue(await Promise.all(args.dates.flatMap((date) => [
      trainRouteAvailable(args, cityName, args.availability.endpointPlan.arrivalCity, date),
      trainRouteAvailable(args, args.availability.endpointPlan.departureCity, cityName, date),
    ])));
  }
  const endpoints = args.availability.endpointPlan.flight;
  if (!endpoints) throw new Error("飞机前置校验缺少已确认机场。");
  const candidates = await (args.dependencies?.searchOriginAirports?.(cityName) ?? searchAirports(args.page, cityName));
  const airports = candidates.filter((candidate) => /^[A-Z]{3}$/.test(candidate.code)).slice(0, 2);
  for (const airport of airports) {
    const checks = await Promise.all(args.dates.flatMap((date) => [
      flightRouteAvailable(args, airport.code, endpoints.arrival.code, date),
      flightRouteAvailable(args, endpoints.departure.code, airport.code, date),
    ]));
    if (allTrue(checks)) return true;
  }
  return false;
}

async function trainRouteAvailable(args: Parameters<typeof probeVariant>[0], from: string, to: string, date: string): Promise<boolean> {
  const route = `${citySlug(from)}-${citySlug(to)}`;
  const url = `https://trains.ctrip.com/TrainBooking/${route}?date=${encodeURIComponent(date)}`;
  return parseCtripTrainAvailability(await fetchHtml(args, url, `查询火车班次 ${from}-${to}`));
}

async function flightRouteAvailable(args: Parameters<typeof probeVariant>[0], from: string, to: string, date: string): Promise<boolean> {
  const url = `https://flights.ctrip.com/booking/${from}-${to}-day-1.html?date=${encodeURIComponent(date)}`;
  return parseCtripFlightAvailability(await fetchHtml(args, url, `查询航班 ${from}-${to}`));
}

async function fetchHtml(args: Parameters<typeof probeVariant>[0], url: string, label: string): Promise<string> {
  if (args.dependencies?.fetchHtml) return args.dependencies.fetchHtml(url, label);
  if (!args.page.vbkSessionGetText) throw new Error(`${label}缺少浏览器会话读取能力。`);
  const response = await args.page.vbkSessionGetText({ endpoint: url, errorLabel: label });
  if (response.status < 200 || response.status >= 300) throw new Error(`${label}失败：HTTP ${response.status}`);
  return response.text;
}

export function parseCtripFlightAvailability(html: string): boolean {
  if (/\\?"flightNo\\?"\s*:\s*\\?"[A-Z0-9]{3,8}/.test(html)) return true;
  if (/无航班|暂无(?:可售)?航班|未找到[^<]{0,20}航班/.test(html)) return false;
  throw new Error("携程航班页未返回可识别的班次结论。");
}

export function parseCtripTrainAvailability(html: string): boolean {
  const nextData = html.match(/<script[^>]+id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/)?.[1];
  if (nextData) {
    try {
      const parsed = JSON.parse(nextData) as JsonRecord;
      const pageProps = asRecord(asRecord(parsed.props)?.pageProps);
      const initialState = asRecord(pageProps?.initialState);
      const search = asRecord(initialState?.trainSearchInfo);
      if (Array.isArray(search?.trainInfoList)) return search.trainInfoList.length > 0;
    } catch {
      throw new Error("携程火车页班次数据无法解析。");
    }
  }
  const count = html.match(/共\s*(\d+)\s*车次/);
  if (count) return Number(count[1]) > 0;
  if (/未找到符合条件的车次|暂无(?:可售)?车次/.test(html)) return false;
  throw new Error("携程火车页未返回可识别的班次结论。");
}

function loadCityGroups(page: TrafficLinePage): Promise<JsonRecord[]> {
  return postTrafficLineSoa(page, "15638", "getMultiDepartureCities.json", {}, "读取前置校验出发城市")
    .then((payload) => Array.isArray(payload.multiDepartureCities) ? payload.multiDepartureCities as JsonRecord[] : []);
}

function rankGatewayCities(cities: JsonRecord[]): JsonRecord[] {
  const rank = new Map(PREFERRED_GATEWAY_CITIES.map((name, index) => [name, index]));
  return cities.map((city, index) => ({ city, index })).sort((a, b) =>
    (rank.get(text(a.city.cityName)) ?? 100 + a.index) - (rank.get(text(b.city.cityName)) ?? 100 + b.index))
    .map(({ city }) => city);
}

function citySlug(city: string): string {
  return pinyin(city.replace(/市$/, ""), { toneType: "none", type: "array" }).join("").toLowerCase();
}

function checkResult(
  status: TrafficLineScheduleCheck["status"],
  args: Pick<Parameters<typeof probeVariant>[0], "dates" | "cities">,
  reason?: string,
): TrafficLineScheduleCheck {
  return { status, checkedDates: args.dates, checkedCityCount: args.cities.length, ...(reason ? { reason } : {}) };
}

function allTrue(values: boolean[]): boolean { return values.length > 0 && values.every(Boolean); }

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : null;
}

function chunks<T>(values: T[], size: number): T[][] {
  return Array.from({ length: Math.ceil(values.length / size) }, (_, index) => values.slice(index * size, (index + 1) * size));
}
