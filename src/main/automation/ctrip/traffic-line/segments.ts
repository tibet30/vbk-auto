import type { TrafficLineEndpointPlan, TrafficLineStation, TrafficLineVariant } from "../../../../shared/contracts-traffic-line.js";
import { getVbkInitialState, postTrafficLineSoa, list, record, text, type JsonRecord, type TrafficLinePage } from "./client.js";
import {
  departureCityReadbackIsComplete,
  validatedDepartureCityReadbackIsComplete,
  verifyDepartureCityReadback,
  verifyValidatedDepartureCityReadback,
} from "./segment-departure-cities.js";
import { withTraffic } from "./segment-traffic.js";

export { withTraffic } from "./segment-traffic.js";

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
    beforeSubmit?: () => Promise<void>;
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
    await postTrafficLineSoa(page, "15638", "submitSegments", {
      productId, schedule: deterministicSchedule(options.now), adultCount: 2, childCount: 0, audit: { saveStep: 2 },
    }, "提交子产品资源段");
    const rejectedCityIds = await waitForSegmentSubmit(page, productId, options);
    if (!rejectedCityIds.length) break;
    const rejected = new Set(rejectedCityIds);
    const nextCities = selectedCities.filter((city) => !rejected.has(text(city.cityId)));
    if (!nextCities.length) throw new Error("VBK 校验后没有任何可用的多出发城市，子产品未激活。");
    if (nextCities.length === selectedCities.length || round === 3) {
      throw new Error("VBK 多出发城市校验连续失败，已停止重试且子产品未激活。");
    }
    selectedCities = nextCities;
  }

  // result=T 仍可能表示平台把全部无票城市自动剔除；只读等待正式资源，绝不
  // 在校验结束后把原始城市集合重新写回。正式结果允许是提交集合的非空子集。
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
  if (Array.isArray(record(payload.draftProductSegments)?.segments)) {
    throw new Error("子产品资源仍存在未发布草稿，不能作为正式回读。");
  }
  const segments = list(record(payload.productSegments)?.segments);
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

export async function waitForSegmentSubmit(
  page: TrafficLinePage,
  productId: string,
  options: { maxPolls?: number; sleep?: (milliseconds: number) => Promise<void> } = {},
): Promise<string[]> {
  const maxPolls = options.maxPolls ?? 210;
  const sleep = options.sleep ?? ((milliseconds) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  let missingResultPolls = 0;
  for (let attempt = 1; attempt <= maxPolls; attempt += 1) {
    let payload: JsonRecord;
    try {
      payload = await postTrafficLineSoa(page, "15638", "getSubmitSegmentsResult", { productId }, "读取子产品资源提交结果");
    } catch (error) {
      // 结果记录可能短暂不可见，但该错误也可能表示 submit 根本未启动校验。
      // 因此只做少量读回，不盲目重提；超过宽限后以可安全续跑的明确错误停止。
      if (!segmentValidationResultMissing(error)) throw error;
      missingResultPolls += 1;
      if (missingResultPolls >= 5 || attempt === maxPolls) {
        throw new Error(`子产品资源提交后未启动班期校验，已只读确认 ${missingResultPolls} 次；未重复提交，可安全重试。`);
      }
      await sleep(Math.min(1_500, 500 * attempt));
      continue;
    }
    const result = text(payload.result);
    if (result === "T") return [];
    if (result === "F") {
      const rejectedCityIds = list(payload.checkSegmentResultCities)
        .map((item) => text(record(item.city)?.cityId))
        .filter(Boolean);
      if (rejectedCityIds.length) return [...new Set(rejectedCityIds)];
      throw new Error(`子产品资源提交未通过：${messageText(payload.messages) || "VBK 未返回可用交通资源。"}`);
    }
    if (result !== "U") throw new Error(`子产品资源提交返回未知状态「${result || "空"}」。`);
    if (attempt < maxPolls) await sleep(Math.min(1_500, 500 * attempt));
  }
  throw new Error(`子产品资源提交在 ${maxPolls} 次轮询后仍未完成。`);
}

function segmentValidationResultMissing(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("产品班期校验结果不存在") && message.includes("班期校验已经开始");
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
  const groups = list(payload.multiDepartureCities);
  const key = variant === "flightRoundTrip" ? "hasAirport" : "hasTrain";
  const destinationId = text(destination.cityId);
  return groups.flatMap((group) => list(group.departureCities))
    .filter((city) => city[key] === true && text(city.cityId) !== destinationId);
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

function messageText(value: unknown): string {
  return Array.isArray(value) ? value.map(text).filter(Boolean).join("；") : text(value);
}

function deterministicSchedule(now = new Date()): string[] {
  return [14].map((offset) => {
    const date = new Date(now); date.setDate(date.getDate() + offset); return date.toISOString().slice(0, 10);
  });
}
