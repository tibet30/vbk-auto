/**
 * traffic-line/itinerary.ts（card-builders 子模块）：
 *   构造 / 完善 traffic 节点的 flight / train 卡片：
 *   - finaliseTrafficNode          根据 variant 把 traffic 节点收尾（包 package + legacy + useSegmentConfig 关闭）；
 *   - trafficNodeWithRequiredCard  按 variant 调 train / flight 两个分支构造包 + legacy；
 *   - flightPackageCard            新建一个 flight package 占位卡；
 *   - completeFlightPackageCard    补全既有卡的出发 / 到达机场；
 *   - flightLegacyCard             新建一个 flight legacy 占位；
 *   - trainNodeWithRequiredCard    按 direction 构造 train 包 + legacy；
 *   - completeTrainPackageCard     补全既有卡的出发 / 到达站；
 *   - trainPackageCard             新建一个 train package 占位；
 *   - trafficEndpointPlaceholder   出发地 / 目的地占位对象；
 *   - trainLegacyCard              新建一个 train legacy 占位。
 */

import { emptyTourDailyFlight, emptyTourDailyTrain } from "../../itinerary-api/info-skeletons.js";
import { list, record, type JsonRecord } from "../client.js";
import type { TrafficLineEndpointPlan, TrafficLineVariant } from "../../../../../shared/contracts-traffic-line.js";
import { expectedTrafficKey } from "./traffic-merge.js";
import { isTrafficNode } from "./readback.js";
import { hasNamedCode, hasUsableLegacyFlight, hasUsableLegacyTrain, hasUsablePackageFlight, hasUsablePackageTrain } from "./predicates.js";

export function finaliseTrafficNode(
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

export function trafficNodeWithRequiredCard(
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

export function flightPackageCard(
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

export function completeFlightPackageCard(
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

export function flightLegacyCard(
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

export function trainNodeWithRequiredCard(
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

export function completeTrainPackageCard(
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

export function trainPackageCard(
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

export function trafficEndpointPlaceholder(name: "出发地" | "目的地"): JsonRecord {
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

export function trainLegacyCard(
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