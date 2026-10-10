export { ensureTrafficLineItinerary, waitForTrafficLineItineraryReadback } from "./itinerary-materialization.js";
import type { TrafficLineEndpointPlan, TrafficLineVariant } from "../../../../shared/contracts-traffic-line.js";
import { emptyTourDailyFlight, emptyTourDailyTrain } from "../itinerary-api/info-skeletons.js";
import type { FetchTourInfoIdResult } from "../itinerary-api/steps.js";
import { getVbkInitialState, list, record, text, type JsonRecord, type TrafficLinePage } from "./client.js";

/** 交通子产品只认平台明确的当前 tourInfoId，旧 audit/draft/preview 均不得兜底。 */
export function currentTrafficLineTourInfoId(linked: FetchTourInfoIdResult): string {
  const current = text(linked.tourInfo.tourInfoId);
  return current === "0" ? "" : current;
}

export function mergeTrafficNodes(
  tourInfo: JsonRecord,
  firstTransport: JsonRecord,
  lastTransport: JsonRecord,
  variant: TrafficLineVariant,
  endpoints?: TrafficLineEndpointPlan,
): JsonRecord {
  const result = structuredClone(tourInfo);
  const days = list(result.tourDailyDescriptions);
  if (!days.length) throw new Error("子产品行程没有任何天数，无法插入交通节点。");
  const singleDay = days.length === 1;
  const first = structuredClone(days[0]!);
  const last = structuredClone(days.at(-1)!);
  const firstInfos = list(first.tourDailyInfos);
  const lastInfos = singleDay ? firstInfos : list(last.tourDailyInfos);
  const expected = expectedTrafficKey(variant);
  const firstNode = trafficNodeWithRequiredCard(firstTransport, variant, "enter", endpoints);
  const lastNode = trafficNodeWithRequiredCard(lastTransport, variant, "leave", endpoints);
  replaceIncompleteEdgeTraffic(firstInfos, firstNode, expected, 1, "start");
  replaceIncompleteEdgeTraffic(lastInfos, lastNode, expected, singleDay ? 2 : 1, "end");
  first.tourDailyInfos = firstInfos.map((node, index) => finaliseTrafficNode(node, variant, "enter", index + 1, endpoints));
  if (singleDay) {
    days[0] = first;
  } else {
    last.tourDailyInfos = lastInfos.map((node, index) => finaliseTrafficNode(node, variant, "leave", index + 1, endpoints));
    days[0] = first; days[days.length - 1] = last;
  }
  result.tourDailyDescriptions = days;
  return result;
}

export function verifyTrafficNodes(tourInfo: JsonRecord, variant: TrafficLineVariant): number {
  const days = list(tourInfo.tourDailyDescriptions);
  if (!days.length) throw new Error("子产品行程交通回读没有任何天数。");
  const expected = expectedTrafficKey(variant);
  const firstCount = list(days[0]?.tourDailyInfos).filter((node) => isCompleteTrafficNode(node, expected)).length;
  const lastCount = list(days.at(-1)?.tourDailyInfos).filter((node) => isCompleteTrafficNode(node, expected)).length;
  const required = days.length === 1 ? 2 : 1;
  if (firstCount < 1 || lastCount < required) {
    throw new Error(`子产品行程交通回读缺少首日或末日目标交通节点（${describeEdgeDays(tourInfo, expected)}）。`);
  }
  return days.reduce((sum, day) => sum + list(day.tourDailyInfos).filter((node) => isCompleteTrafficNode(node, expected)).length, 0);
}

/** 首末边界日的节点清单诊断：节点是否还在、交通节点是否缺车次/航班卡片。 */
function describeEdgeDays(tourInfo: JsonRecord, expected: number): string {
  const days = list(tourInfo.tourDailyDescriptions);
  if (!days.length) return "行程没有任何天数";
  const singleDay = days.length === 1;
  const edgeDays = singleDay ? [days[0]!] : [days[0]!, days.at(-1)!];
  const labels = singleDay ? ["唯一日"] : ["首日", "末日"];
  return edgeDays.map((day, index) => {
    const nodes = list(day?.tourDailyInfos).map((node) => {
      const activeType = record(node.activeType);
      const name = text(activeType?.name) || `key=${text(activeType?.key) || "?"}`;
      if (isCompleteTrafficNode(node, expected)) return `${name}✓`;
      if (isTrafficNode(node, expected)) return `${name}(缺车次/航班卡片)`;
      return name;
    });
    return `${labels[index]}[${nodes.join("、") || "无节点"}]`;
  }).join("；");
}

function expectedTrafficKey(variant: TrafficLineVariant): number {
  return variant === "flightRoundTrip" ? 2 : 14;
}

function replaceIncompleteEdgeTraffic(
  infos: JsonRecord[],
  sourceNode: JsonRecord,
  expected: number,
  requiredCount: number,
  insert: "start" | "end",
): void {
  const kept = infos.filter((node) => !isTrafficNode(node, expected) || isCompleteTrafficNode(node, expected));
  infos.splice(0, infos.length, ...kept);
  if (infos.filter((node) => isCompleteTrafficNode(node, expected)).length >= requiredCount) return;
  if (insert === "start") infos.unshift(sourceNode);
  else infos.push(sourceNode);
}

/**
 * VBK 会在套餐有效化时再次校验风险 POI。子产品复制出的行程可能保留候选
 * riskPlanList，却没有选中的 riskPlanCode；先锁定费用口径，再采用该口径内
 * VBK 排在首位的默认方案，绝不跨口径猜测。
 */
export function applyRequiredPoiRiskPlans(tourInfo: JsonRecord): JsonRecord {
  const result = structuredClone(tourInfo);
  for (const day of list(result.tourDailyDescriptions)) {
    for (const node of list(day.tourDailyInfos)) {
      for (const dailyPoi of list(node.tourDailyPois)) {
        const poi = record(dailyPoi.poi);
        if (!poi || poi.isRisk !== true || text(dailyPoi.riskPlanCode)) continue;
        const expected = riskCostInclude(dailyPoi, node);
        const available = list(poi.riskPlanList).filter((plan) => {
          const code = text(plan.riskPlanCode);
          const description = text(plan.riskPlanDesc);
          return code && description;
        });
        const matching = expected === null
          ? available
          : available.filter((plan) => text(plan.costInclude) === expected);
        const applicability = new Set(available.map((plan) => text(plan.costInclude)).filter(Boolean));
        const candidates = matching.length ? matching : applicability.size === 1 ? available : [];
        if (!candidates.length) {
          throw new Error(`风险 POI「${text(poi.poiName) || text(poi.poiId)}」无法唯一确认备选方案；未激活交通子产品。`);
        }
        // 同一费用口径下，VBK riskPlanList 顺序就是平台默认优先级；只在已确认
        // 口径内取首项，不跨口径猜测。
        dailyPoi.riskPlanCode = candidates[0]!.riskPlanCode;
        dailyPoi.riskPlanDesc = candidates[0]!.riskPlanDesc;
      }
    }
  }
  return result;
}

function riskCostInclude(dailyPoi: JsonRecord, node: JsonRecord): "T" | "F" | null {
  const explicit = dailyPoi.costInclude ?? node.costInclude;
  if (explicit === true || explicit === "T") return "T";
  if (explicit === false || explicit === "F") return "F";
  const suffix = text(record(dailyPoi.suffixName)?.name);
  if (/不含/.test(suffix)) return "F";
  if (/含/.test(suffix)) return "T";
  return null;
}

export async function readTrafficNodesFromPage(page: TrafficLinePage, productId: string, variant: TrafficLineVariant): Promise<{ first: JsonRecord; last: JsonRecord }> {
  const endpoint = `https://vbooking.ctrip.com/ivbk/vendor/TourDays?productid=${encodeURIComponent(productId)}&istab=1&from=vbk`;
  const state = await getVbkInitialState(page, endpoint, "子产品行程页");
  const context = record(state.dailyContext) ?? state;
  const days = list(context.tourDailyDescriptions);
  const expected = expectedTrafficKey(variant);
  const first = list(days[0]?.tourDailyInfos).find((node) => isTrafficNode(node, expected));
  const last = list(days.at(-1)?.tourDailyInfos).find((node) => isTrafficNode(node, expected));
  if (!first || !last) throw new Error(`子产品 ${productId} 行程页未返回可用的首末日交通节点，需先核对资源段提交结果。`);
  return { first, last };
}

function isTrafficNode(node: JsonRecord, expectedKey: number): boolean {
  const activeType = record(node.activeType);
  return Number(activeType?.key) === expectedKey
    || (expectedKey === 2 && /航班|飞机/.test(text(activeType?.name)))
    || (expectedKey === 14 && /火车|高铁/.test(text(activeType?.name)));
}

function isCompleteTrafficNode(node: JsonRecord, expectedKey: number): boolean {
  if (!isTrafficNode(node, expectedKey)) return false;
  if (expectedKey === 2) return hasFlightCard(node);
  if (expectedKey === 14) return hasTrainCard(node);
  return true;
}

function finaliseTrafficNode(
  node: JsonRecord,
  variant: TrafficLineVariant,
  direction: "enter" | "leave",
  sort: number,
  endpoints?: TrafficLineEndpointPlan,
): JsonRecord {
  const expected = expectedTrafficKey(variant);
  const finalised = isTrafficNode(node, expected)
    ? trafficNodeWithRequiredCard(node, variant, direction, endpoints)
    : structuredClone(node);
  return { ...finalised, sort };
}

function trafficNodeWithRequiredCard(
  node: JsonRecord,
  variant: TrafficLineVariant,
  direction: "enter" | "leave",
  endpoints?: TrafficLineEndpointPlan,
): JsonRecord {
  const next = structuredClone(node);
  if (variant === "trainRoundTrip"
    && list(next.tourDailyPackageTrains).some(card =>
      list(card.departureStationList).some(hasNamedCode) || list(card.arriveStationList).some(hasNamedCode))) {
    next.useSegmentConfig = false;
    return next;
  }
  // Resource configuration does not replace explicit itinerary cards. Disable it
  // for both variants before validation, including empty legacy train nodes.
  next.useSegmentConfig = false;
  if (variant === "trainRoundTrip") return trainNodeWithRequiredCard(next, direction, endpoints);
  if (variant !== "flightRoundTrip") return next;
  if (!list(next.tourDailyPackageFlights).some(hasUsablePackageFlight)) {
    next.tourDailyPackageFlights = [flightPackageCard(direction, endpoints)];
  } else {
    next.tourDailyPackageFlights = list(next.tourDailyPackageFlights).map((card) => completeFlightPackageCard(card, direction, endpoints));
  }
  if (!list(next.tourDailyFlights).some((item) => hasUsableLegacyFlight(record(item.flight)))) {
    next.tourDailyFlights = [flightLegacyCard(direction, endpoints)];
  }
  return next;
}

function flightPackageCard(
  direction: "enter" | "leave",
  endpoints?: TrafficLineEndpointPlan,
): JsonRecord {
  const station = direction === "enter" ? endpoints?.flight?.arrival : endpoints?.flight?.departure;
  const card: JsonRecord = {
    tourDailyPackageFlightId: null,
    sort: null,
    directFlightFlag: { key: null, name: null },
    flightNo: null,
    departureLocation: direction === "enter" ? trafficEndpointPlaceholder("出发地") : null,
    departureAirports: direction === "leave" ? [{ code: station?.code ?? "", name: station?.name ?? null }] : [{ code: "", name: null }],
    arriveLocation: direction === "leave" ? trafficEndpointPlaceholder("目的地") : null,
    arriveAirports: direction === "enter" ? [{ code: station?.code ?? "", name: station?.name ?? null }] : [{ code: "", name: null }],
    departureTime: { key: "N", name: "不限" },
    departureTimeOffset: null,
    arriveTime: { key: "N", name: "不限" },
    arriveDateOffset: null,
    packageSubClass: null,
    checkedBaggage: null,
    piecePerPerson: null,
    weightPerBaggage: null,
    weightTotalBaggage: null,
    stopLocations: [],
    transferGroup: null,
    refId: null,
    parentId: null,
  };
  return card;
}

function completeFlightPackageCard(
  card: JsonRecord,
  direction: "enter" | "leave",
  endpoints?: TrafficLineEndpointPlan,
): JsonRecord {
  const station = direction === "enter" ? endpoints?.flight?.arrival : endpoints?.flight?.departure;
  const next = { ...card };
  if (direction === "enter") {
    if (!hasNamedCode(record(next.departureLocation))) next.departureLocation = trafficEndpointPlaceholder("出发地");
    if (!list(next.arriveAirports).some(hasNamedCode)) next.arriveAirports = [{ code: station?.code ?? "", name: station?.name ?? null }];
  } else {
    if (!list(next.departureAirports).some(hasNamedCode)) next.departureAirports = [{ code: station?.code ?? "", name: station?.name ?? null }];
    if (!hasNamedCode(record(next.arriveLocation))) next.arriveLocation = trafficEndpointPlaceholder("目的地");
  }
  return next;
}

function flightLegacyCard(
  direction: "enter" | "leave",
  endpoints?: TrafficLineEndpointPlan,
): JsonRecord {
  const legacy = emptyTourDailyFlight() as JsonRecord;
  const flight = record(legacy.flight);
  const station = direction === "enter" ? endpoints?.flight?.arrival : endpoints?.flight?.departure;
  if (flight) {
    if (direction === "enter") flight.arriveAirport = { code: station?.code ?? null, name: station?.name ?? null };
    else flight.departureAirport = { code: station?.code ?? null, name: station?.name ?? null };
    legacy.flight = flight;
  }
  return legacy;
}

function trainNodeWithRequiredCard(
  node: JsonRecord,
  direction: "enter" | "leave",
  endpoints?: TrafficLineEndpointPlan,
): JsonRecord {
  const next = structuredClone(node);
  const station = direction === "enter" ? endpoints?.train?.arrival : endpoints?.train?.departure;
  if (!list(next.tourDailyPackageTrains).some(hasUsablePackageTrain)) {
    next.tourDailyPackageTrains = [trainPackageCard(direction, station)];
  } else {
    next.tourDailyPackageTrains = list(next.tourDailyPackageTrains).map((card) => completeTrainPackageCard(card, direction, station));
  }
  if (!list(next.tourDailyTrains).some((item) => hasUsableLegacyTrain(record(item.train)))) {
    next.tourDailyTrains = [trainLegacyCard(direction, station)];
  }
  return next;
}

function completeTrainPackageCard(
  card: JsonRecord,
  direction: "enter" | "leave",
  station: NonNullable<TrafficLineEndpointPlan["train"]>["arrival"] | undefined,
): JsonRecord {
  const next = { ...card };
  if (direction === "enter") {
    if (!hasNamedCode(record(next.departureLocation))) next.departureLocation = trafficEndpointPlaceholder("出发地");
    if (!list(next.arriveTrainStations).some(hasNamedCode)) {
      next.arriveTrainStations = [{ stationName: station?.name ?? null, locationCode: station?.code ?? null }];
    }
  } else {
    if (!list(next.departureTrainStations).some(hasNamedCode)) {
      next.departureTrainStations = [{ stationName: station?.name ?? null, locationCode: station?.code ?? null }];
    }
    if (!hasNamedCode(record(next.arriveLocation))) next.arriveLocation = trafficEndpointPlaceholder("目的地");
  }
  return next;
}

function trainPackageCard(
  direction: "enter" | "leave",
  station: NonNullable<TrafficLineEndpointPlan["train"]>["arrival"] | undefined,
): JsonRecord {
  return {
    tourDailyPackageTrainId: null,
    sort: null,
    trainNo: null,
    departureLocation: direction === "enter" ? trafficEndpointPlaceholder("出发地") : null,
    departureTrainStations: direction === "leave" ? [{ stationName: station?.name ?? null, locationCode: station?.code ?? null }] : [],
    arriveLocation: direction === "leave" ? trafficEndpointPlaceholder("目的地") : null,
    arriveTrainStations: direction === "enter" ? [{ stationName: station?.name ?? null, locationCode: station?.code ?? null }] : [],
    departureTime: { key: "N", name: "不限" },
    departureTimeOffset: null,
    arriveTime: { key: "N", name: "不限" },
    arriveDateOffset: null,
    refId: null,
    parentId: null,
  };
}

function trafficEndpointPlaceholder(name: "出发地" | "目的地"): JsonRecord {
  return {
    globalId: null,
    name,
    categoryId: null,
    type: "base",
    code: null,
    oversea: null,
    parents: null,
    trainStations: null,
    airports: null,
  };
}

function trainLegacyCard(
  direction: "enter" | "leave",
  station: NonNullable<TrafficLineEndpointPlan["train"]>["arrival"] | undefined,
): JsonRecord {
  const legacy = emptyTourDailyTrain() as JsonRecord;
  const train = record(legacy.train);
  if (train) {
    if (direction === "enter") train.arriveStation = station?.name ?? null;
    else train.departureStation = station?.name ?? null;
    legacy.train = train;
  }
  return legacy;
}

function hasFlightCard(node: JsonRecord): boolean {
  return list(node.tourDailyPackageFlights).some(hasUsablePackageFlight)
    || list(node.tourDailyFlights).some((item) => hasUsableLegacyFlight(record(item.flight)));
}

function hasTrainCard(node: JsonRecord): boolean {
  return list(node.tourDailyPackageTrains).some(hasUsablePackageTrain)
    || list(node.tourDailyTrains).some((item) => hasUsableLegacyTrain(record(item.train)));
}

function hasUsablePackageFlight(card: JsonRecord): boolean {
  return Boolean(text(card.flightNo))
    || list(card.departureAirports).some(hasNamedCode)
    || list(card.arriveAirports).some(hasNamedCode)
    || Boolean(text(card.departureLocation))
    || Boolean(text(card.arriveLocation));
}

function hasUsableLegacyFlight(flight: JsonRecord | null): boolean {
  if (!flight) return false;
  return Boolean(text(flight.flightNo))
    || hasNamedCode(record(flight.departureAirport))
    || hasNamedCode(record(flight.arriveAirport))
    || Boolean(text(flight.departureAirportName))
    || Boolean(text(flight.arriveAirportName));
}

function hasUsablePackageTrain(card: JsonRecord): boolean {
  return Boolean(text(card.trainNo))
    || list(card.departureStationList).some(hasNamedCode)
    || list(card.arriveStationList).some(hasNamedCode)
    || list(card.departureTrainStations).some(hasNamedCode)
    || list(card.arriveTrainStations).some(hasNamedCode)
    || Boolean(text(card.departureLocation))
    || Boolean(text(card.arriveLocation));
}

function hasUsableLegacyTrain(train: JsonRecord | null): boolean {
  if (!train) return false;
  return Boolean(text(train.trainNo))
    || Boolean(text(train.departureStation))
    || Boolean(text(train.arriveStation));
}

function hasNamedCode(value: JsonRecord | null): boolean {
  if (!value) return false;
  return Boolean(text(value.code) || text(value.name) || text(value.locationCode) || text(value.stationName));
}
