import type { TrafficLineEndpointPlan, TrafficLineStation, TrafficLineVariant } from "../../../../shared/contracts-traffic-line.js";
import { datesBetween, localBusinessDate, VBK_MAX_PRICING_INVENTORY_DAYS } from "../pricing-api.js";
import { getVbkInitialState, postTrafficLineSoa, list, record, text, type JsonRecord, type TrafficLinePage } from "./client.js";
import {
  departureCityReadbackIsComplete,
  validatedDepartureCityReadbackIsComplete,
  verifyDepartureCityReadback,
  verifyValidatedDepartureCityReadback,
} from "./segment-departure-cities.js";
import { withTraffic } from "./segment-traffic.js";
import { readSegmentSubmitState, waitForSegmentSubmit } from "./segment-submit.js";

export { withTraffic } from "./segment-traffic.js";
export { trafficLineResourcePageUrl, waitForSegmentSubmit } from "./segment-submit.js";

type Segment = JsonRecord;
type City = JsonRecord;

export async function ensureTrafficLineSegments(
  page: TrafficLinePage,
  productId: string,
  variant: TrafficLineVariant,
  endpoints: TrafficLineEndpointPlan,
  options: {
    maxPolls?: number;
    sleep?: (milliseconds: number) => Promise<void>;
    now?: Date;
    /** 母产品实际售卖班期；平台用此集合而不是任意未来日期校验交通资源。 */
    schedule?: readonly string[];
    beforeSubmit?: () => Promise<void>;
    onSubmit?: (departureCityCount: number) => void;
    onValidationProgress?: (attempt: number, maxPolls: number) => void;
  } = {},
): Promise<{ segmentCount: number; departureCityCount: number }> {
  const before = await ensureSegmentDraft(page, productId, options.sleep);
  let current = segmentsFromPayload(before);
  if (!current.length) throw new Error("子产品资源配置未返回任何行程段。");
  const destination = inferDestination(current);
  if (!isMultiDeparture(current[0]!)) {
    await saveSegment(page, buildBoundarySegment(current[0]!, 1, multiCity("多出发"), destination));
    current = segmentsFromPayload(await getSegments(page, productId));
    if (!current.length || !isMultiDeparture(current[0]!)) {
      throw new Error("保存多出发资源段后平台回读不一致。");
    }
  }
  if (!current.length) throw new Error("保存多出发资源段后未返回任何行程段。");
  if (!isMultiArrival(current.at(-1)!)) {
    await saveSegment(page, buildBoundarySegment(current.at(-1)!, current.length + 1, destination, multiCity("多到达")));
  }

  const draft = await getSegments(page, productId);
  const segments = segmentsFromPayload(draft);
  if (segments.length < 2) throw new Error("子产品资源段边界保存后未返回首末段。");
  const first = segments[0]!;
  const last = segments.at(-1)!;
  await saveSegment(page, withTraffic(first, variant, "enter", endpoints));
  await saveSegment(page, withTraffic(last, variant, "leave", endpoints));
  verifySegmentBoundaries(segmentsFromPayload(await getSegments(page, productId)), variant, endpoints);

  const cities = await compatibleDepartureCities(page, variant, destination);
  if (!cities.length) throw new Error(`VBK 未返回可用于${variant === "flightRoundTrip" ? "飞机" : "火车"}往返的出发城市。`);
  const modifyUser = await resolveTrafficLineModifyUser(page, productId);
  let selectedCities = cities;
  for (let round = 1; round <= 3; round += 1) {
    await saveDepartureCities(page, productId, selectedCities);
    verifyDepartureCityReadback(await getSegments(page, productId), selectedCities);
    // publishProductModules 会把可写 draft 结算为正式资源，同时让 TourDays
    // 生成首末日交通节点。结算后必须重建并回读 draft，再度保存
    // 多出发城市与行程卡片，否则 submitSegments 虽可能返回 Ack=Success，
    // 实际不会创建班期校验任务。
    await publishSegmentModule(page, productId, modifyUser, variant, endpoints, selectedCities);
    const submitDraft = segmentsFromPayload(await ensureSegmentDraft(page, productId, options.sleep));
    verifySegmentBoundaries(submitDraft, variant, endpoints);
    await saveDepartureCities(page, productId, selectedCities);
    verifyDepartureCityReadback(await getSegments(page, productId), selectedCities);
    await options.beforeSubmit?.();
    verifySegmentBoundaries(segmentsFromPayload(await getSegments(page, productId)), variant, endpoints);
    options.onSubmit?.(selectedCities.length);
    await postTrafficLineSoa(page, "15638", "submitSegments", {
      productId, schedule: resourceCheckSchedule(options.schedule, options.now), adultCount: 2, childCount: 0, audit: { saveStep: 2 },
    }, "提交子产品资源段");
    const rejectedCityIds = await waitForSegmentSubmit(page, productId, {
      maxPolls: options.maxPolls,
      sleep: options.sleep,
      onProgress: options.onValidationProgress,
    });
    if (!rejectedCityIds.length) break;
    const rejected = new Set(rejectedCityIds);
    const nextCities = selectedCities.filter((city) => !rejected.has(text(city.cityId)));
    if (!nextCities.length) throw new Error("VBK 校验后没有任何可用的多出发城市，子产品未激活。");
    if (nextCities.length === selectedCities.length || round === 3) {
      throw new Error("VBK 多出发城市校验连续失败，已停止重试且子产品未激活。");
    }
    selectedCities = nextCities;
  }

  // result=T 可能已剔除无票城市；只读等待正式资源，不把原始城市集合写回。
  const finalPayload = await waitForValidatedSegmentReadback(
    page, productId, variant, endpoints, selectedCities, options.sleep,
  );
  const verified = segmentsFromPayload(finalPayload);
  verifySegmentBoundaries(verified, variant, endpoints);
  const departureCityCount = verifyValidatedDepartureCityReadback(finalPayload, selectedCities);
  return { segmentCount: verified.length, departureCityCount };
}

export function segmentsFromPayload(payload: JsonRecord): Segment[] {
  return list(record(payload.draftProductSegments)?.segments ?? record(payload.productSegments)?.segments);
}

export async function readTrafficLineSegmentReadback(
  page: TrafficLinePage,
  productId: string,
  variant: TrafficLineVariant,
  endpoints: TrafficLineEndpointPlan,
): Promise<{ segmentCount: number; departureCityCount: number }> {
  const payload = await getSegments(page, productId);
  const segments = list(record(payload.productSegments)?.segments);
  // 已激活子产品的 getSegments 可同时返回编辑草稿和已发布资源段。最终回读
  // 只以 productSegments 的完整性为准；草稿并存不表示正式资源不存在。
  if (!segments.length) throw new Error("子产品未返回可作为正式回读的资源段。");
  verifySegmentBoundaries(segments, variant, endpoints);
  return { segmentCount: segments.length, departureCityCount: verifyValidatedDepartureCityReadback(payload) };
}

export function buildBoundarySegment(template: Segment, segmentNumber: number, departureCity: City, destinationCity: City): Segment {
  return {
    productId: template.productId,
    segmentId: 0,
    segmentBase: {
      departureAdjustDays: 0,
      segmentNumber,
      departureCity: structuredClone(departureCity),
      destinationCity: structuredClone(destinationCity),
    },
  };
}

async function ensureSegmentDraft(
  page: TrafficLinePage,
  productId: string,
  sleep = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)),
): Promise<JsonRecord> {
  // 新建子产品在创建 segment 草稿前没有 getSegments 权限；创建接口本身可安全重入。
  await postTrafficLineSoa(page, "15638", "createProductDraft", { productId, module: "segment" }, "创建子产品资源草稿");
  let lastError: unknown;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      const draft = await getSegments(page, productId);
      if (Array.isArray(record(draft.draftProductSegments)?.segments)) return draft;
      lastError = new Error("子产品资源草稿初始化后仍不可写。");
    } catch (error) {
      lastError = error;
    }
    if (attempt < 5) await sleep(attempt * 300);
  }
  throw lastError instanceof Error ? lastError : new Error("子产品资源草稿初始化后仍不可写。");
}

async function getSegments(page: TrafficLinePage, productId: string): Promise<JsonRecord> {
  return postTrafficLineSoa(page, "15638", "getSegments", { productId }, "读取子产品资源段");
}

async function saveSegment(page: TrafficLinePage, segment: Segment): Promise<void> {
  await postTrafficLineSoa(page, "15638", "saveSegment", { segment }, "保存子产品资源段");
}

async function saveDepartureCities(page: TrafficLinePage, productId: string, cities: City[]): Promise<void> {
  await postTrafficLineSoa(page, "15638", "SaveSegmentCommonData", {
    segmentCommonData: { productId, departureCities: cities, isCityManage: "F" },
  }, "保存子产品多出发城市");
}

async function publishSegmentModule(
  page: TrafficLinePage,
  productId: string,
  modifyUser: string,
  variant: TrafficLineVariant,
  endpoints: TrafficLineEndpointPlan,
  expectedCities: City[] = [],
): Promise<void> {
  try {
    await postTrafficLineSoa(page, "15638", "publishProductModules", {
      productId: Number(productId) || productId,
      module: "segment",
      modifyUser,
    }, "提交子产品资源模块");
  } catch (error) {
    if (!/BrowserView 执行超时|浏览器请求超时/.test(String(error))) throw error;
    // 超时时不能猜测服务端是否已接受写入，也不能立即重提。
    // 只有草稿已被消耗且正式资源边界完整时，才将本次视为已落库。
    const readback = await getSegments(page, productId);
    if (!publishedSegmentReadbackIsComplete(readback, variant, endpoints, expectedCities)) throw error;
  }
}

export function publishedSegmentReadbackIsComplete(
  payload: JsonRecord,
  variant: TrafficLineVariant,
  endpoints: TrafficLineEndpointPlan,
  expectedCities: City[] = [],
): boolean {
  if (Array.isArray(record(payload.draftProductSegments)?.segments)) return false;
  try {
    verifySegmentBoundaries(segmentsFromPayload(payload), variant, endpoints);
    if (!departureCityReadbackIsComplete(payload, expectedCities)) return false;
    return true;
  } catch {
    return false;
  }
}

export function validatedSegmentReadbackIsComplete(
  payload: JsonRecord,
  variant: TrafficLineVariant,
  endpoints: TrafficLineEndpointPlan,
  submittedCities: City[] = [],
): boolean {
  if (Array.isArray(record(payload.draftProductSegments)?.segments)) return false;
  try {
    verifySegmentBoundaries(list(record(payload.productSegments)?.segments), variant, endpoints);
    return validatedDepartureCityReadbackIsComplete(payload, submittedCities);
  } catch {
    return false;
  }
}

async function waitForValidatedSegmentReadback(
  page: TrafficLinePage,
  productId: string,
  variant: TrafficLineVariant,
  endpoints: TrafficLineEndpointPlan,
  submittedCities: City[],
  sleep = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)),
): Promise<JsonRecord> {
  let last: JsonRecord = {};
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    last = await getSegments(page, productId);
    if (validatedSegmentReadbackIsComplete(last, variant, endpoints, submittedCities)) return last;
    if (attempt < 8) await sleep(Math.min(1_500, attempt * 300));
  }
  if (Array.isArray(record(last.draftProductSegments)?.segments)) {
    throw new Error("子产品资源校验完成后仍存在未结算草稿，未激活套餐。");
  }
  const formal = list(record(last.productSegments)?.segments);
  verifySegmentBoundaries(formal, variant, endpoints);
  if (!validatedDepartureCityReadbackIsComplete(last, submittedCities)) {
    const stations = variant === "trainRoundTrip" ? endpoints.train : endpoints.flight;
    const station = stations ? `${stations.arrival.name}/${stations.departure.name}` : "未确认站点";
    throw new Error(`子产品资源校验后没有任何可用的多出发城市（站点：${station}），未激活套餐。`);
  }
  return last;
}

/**
 * 恢复超时任务时先读取上一次 submitSegments 的结果。若平台仍在处理则明确
 * 暂停；若已成功则补齐正式资源回读；仅在明确失败/不存在时允许重新构建草稿。
 */
export type TrafficLineSegmentSubmitRecovery = "recovered" | "restartable" | "pending";

export async function recoverPendingTrafficLineSegmentSubmit(
  page: TrafficLinePage,
  productId: string,
  variant: TrafficLineVariant,
  endpoints: TrafficLineEndpointPlan,
  sleep?: (milliseconds: number) => Promise<void>,
): Promise<TrafficLineSegmentSubmitRecovery> {
  const state = await readSegmentSubmitState(page, productId);
  if (state.status === "missing" || state.status === "failed") return "restartable";
  if (state.status === "pending") return "pending";
  await waitForValidatedSegmentReadback(page, productId, variant, endpoints, [], sleep);
  return "recovered";
}

async function resolveTrafficLineModifyUser(page: TrafficLinePage, productId: string): Promise<string> {
  const endpoint = `https://vbooking.ctrip.com/ivbk/vendor/TourDays?productid=${encodeURIComponent(productId)}&istab=1&from=vbk`;
  const state = await getVbkInitialState(page, endpoint, "读取子产品当前操作账号");
  return trafficLineModifyUserFromState(state);
}

export function trafficLineModifyUserFromState(state: JsonRecord): string {
  const user = record(record(state.userInfo)?.user);
  const modifyUser = text(user?.account) || text(user?.name);
  if (!modifyUser) throw new Error("子产品资源模块缺少当前会话操作账号，未提交资源，可安全重试。");
  return modifyUser;
}

function inferDestination(segments: Segment[]): City {
  const firstBase = record(segments[0]?.segmentBase);
  const firstDeparture = record(firstBase?.departureCity);
  const firstDestination = record(firstBase?.destinationCity);
  const candidate = isMultiCity(firstDeparture) ? firstDestination : firstDeparture;
  if (!candidate || !text(candidate.cityName)) throw new Error("无法从子产品资源段确定目的地城市。");
  return structuredClone(candidate);
}

async function compatibleDepartureCities(page: TrafficLinePage, variant: TrafficLineVariant, destination: City): Promise<City[]> {
  const payload = await postTrafficLineSoa(page, "15638", "getMultiDepartureCities.json", {}, "读取多出发城市");
  return selectTrafficLineValidationCities(list(payload.multiDepartureCities), variant, destination);
}

/**
 * 只校验 VBK「热门」出发城市；字母分组仅用于补齐交通能力字段。
 */
export function selectTrafficLineValidationCities(groups: JsonRecord[], variant: TrafficLineVariant, destination: City): City[] {
  const key = variant === "flightRoundTrip" ? "hasAirport" : "hasTrain";
  const destinationId = text(destination.cityId);
  const destinationName = text(destination.cityName).replace(/市$/, "");
  const capabilityById = new Map<string, City>();
  for (const city of groups.flatMap((group) => list(group.departureCities))) {
    const cityId = text(city.cityId);
    if (cityId && city[key] === true) capabilityById.set(cityId, city);
  }
  const hot = groups.find((group) => text(group.category) === "热门");
  const preferred = hot ? list(hot.departureCities) : [...capabilityById.values()];
  const selected = new Map<string, City>();
  for (const city of preferred) {
    const cityId = text(city.cityId);
    const capable = capabilityById.get(cityId);
    if (!capable || cityId === destinationId || text(capable.cityName).replace(/市$/, "") === destinationName) continue;
    selected.set(cityId, capable);
  }
  return [...selected.values()];
}

function verifySegmentBoundaries(segments: Segment[], variant: TrafficLineVariant, endpoints: TrafficLineEndpointPlan): void {
  const first = segments[0]; const last = segments.at(-1);
  if (!first || !last || !isMultiDeparture(first) || !isMultiArrival(last)) throw new Error("子产品资源段回读缺少多出发或多到达边界。");
  const key = variant === "flightRoundTrip" ? "flight" : "train";
  const firstTraffic = record(first[key]);
  const lastTraffic = record(last[key]);
  if (!firstTraffic || !lastTraffic) throw new Error(`子产品资源段回读缺少首末段 ${key} 交通配置。`);
  const expected = variant === "flightRoundTrip" ? endpoints.flight : endpoints.train;
  if (!expected) throw new Error(`子产品资源段缺少已核实的${variant === "flightRoundTrip" ? "飞机" : "火车"}站点。`);
  verifyStationReadback(firstTraffic, key, expected.arrival, "抵达");
  verifyStationReadback(lastTraffic, key, expected.departure, "返程");
}

function verifyStationReadback(traffic: JsonRecord, key: "flight" | "train", expected: TrafficLineStation, direction: string): void {
  const entering = direction === "抵达";
  const system = record(traffic[key === "flight" ? "systemFlight" : "systemTrain"]);
  const station = key === "flight" ? null : record(system?.[entering ? "destinationStation" : "startStation"]);
  const stationNames = key === "train" && Array.isArray(system?.[entering ? "destinationStations" : "startStations"])
    ? (system?.[entering ? "destinationStations" : "startStations"] as unknown[]).map(text).filter(Boolean)
    : [];
  const code = key === "flight"
    ? text(system?.[entering ? "arrivalAirport" : "departureAirport"])
    : text(station?.key);
  const name = key === "flight" ? expected.name : stationNames.join("、");
  const expectedCode = key === "train" ? text(expected.resourceKey) : expected.code;
  if (code !== expectedCode || (key === "train" && name !== expected.name)) {
    throw new Error(`子产品资源段${direction}${key}站点回读不一致，期望=${expected.name}(${expectedCode})，实际=${name || "空"}(${code || "空"})。`);
  }
}

function isMultiDeparture(segment: Segment): boolean { return isMultiCity(record(record(segment.segmentBase)?.departureCity)); }
function isMultiArrival(segment: Segment): boolean { return isMultiCity(record(record(segment.segmentBase)?.destinationCity)); }
function isMultiCity(city: City | null): boolean { return text(city?.cityId) === "0"; }
function multiCity(name: string): City { return { cityId: 0, cityName: name }; }

/**
 * 交通资源必须按产品实际售卖班期核验，但 submitSegments 是资源可用性探测，
 * 不是价格库存落库。用首日、中间日、末日覆盖整个售卖窗口，避免把 365 天
 * 全量日期交给 VBK 异步校验而长期停留在 U 状态。
 */
export function trafficLineResourceCheckDates(
  product: Record<string, unknown> | undefined,
  now = new Date(),
): string[] {
  const commercial = record(product?.commercial);
  const inventory = record(commercial?.inventory);
  const startDate = text(inventory?.startDate);
  const endDate = text(inventory?.endDate);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate) || startDate > endDate) {
    return [];
  }
  const availableDates = datesBetween(startDate, endDate)
    .filter((date) => date >= localBusinessDate(now))
    .slice(0, VBK_MAX_PRICING_INVENTORY_DAYS);
  if (availableDates.length <= 3) return availableDates;
  return [
    availableDates[0]!,
    availableDates[Math.floor((availableDates.length - 1) / 2)]!,
    availableDates.at(-1)!,
  ];
}

function resourceCheckSchedule(schedule: readonly string[] | undefined, now = new Date()): string[] {
  const valid = [...new Set(schedule?.filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date)) ?? [])];
  // 仅供直接调用的兼容路径；正常交通主流程必须传入产品班期。
  return valid.length ? valid : deterministicSchedule(now);
}

function deterministicSchedule(now = new Date()): string[] {
  return [14].map((offset) => {
    const date = new Date(now); date.setDate(date.getDate() + offset); return date.toISOString().slice(0, 10);
  });
}
