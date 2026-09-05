import type {
  TrafficLineEndpointPlan,
  TrafficLineStation,
  TrafficLineVariant,
} from "../../../../shared/contracts-traffic-line.js";
import { record, text, type JsonRecord } from "./client.js";

type Segment = JsonRecord;

export function withTraffic(
  segment: Segment,
  variant: TrafficLineVariant,
  direction: "enter" | "leave",
  endpoints: TrafficLineEndpointPlan,
): Segment {
  const key = variant === "flightRoundTrip" ? "flight" : "train";
  const station = variant === "flightRoundTrip"
    ? direction === "enter" ? endpoints.flight.arrival : endpoints.flight.departure
    : direction === "enter" ? endpoints.train.arrival : endpoints.train.departure;
  const traffic = record(segment[key]) ?? defaultTrafficDto(key);
  return applyStationToTraffic(segment, key, traffic, station, direction);
}

function applyStationToTraffic(
  segment: Segment,
  key: "flight" | "train",
  traffic: JsonRecord,
  station: TrafficLineStation,
  direction: "enter" | "leave",
): Segment {
  const result = structuredClone(segment);
  const next = structuredClone(traffic);
  if (key === "flight") {
    const systemFlight = record(next.systemFlight);
    if (!systemFlight) throw new Error("子产品 flight DTO 缺少 systemFlight，不能安全写入。");
    systemFlight[direction === "enter" ? "arrivalAirport" : "departureAirport"] = station.code;
    next.systemFlight = systemFlight;
  } else {
    const systemTrain = record(next.systemTrain);
    if (!systemTrain) throw new Error("子产品 train DTO 缺少 systemTrain，不能安全写入。");
    const stationKey = text(station.resourceKey);
    if (!/^\d+$/.test(stationKey)) throw new Error(`${station.name}火车站缺少接口已确认的 stationNo，不能安全写入资源段。`);
    const stationField = direction === "enter" ? "destinationStation" : "startStation";
    const stationsField = direction === "enter" ? "destinationStations" : "startStations";
    systemTrain[stationField] = { key: stationKey, value: "" };
    systemTrain[stationsField] = [station.name];
    next.systemTrain = systemTrain;
  }
  result[key] = next;
  return result;
}

function defaultTrafficDto(key: "flight" | "train"): JsonRecord {
  if (key === "flight") return {
    systemFlight: {
      flightEarliesTimeUnlimited: true,
      flightLatestTime: "",
      sameAirportTransferLimited: "F",
      airRouteMode: "N",
      flightLatestTimeUnlimited: true,
      minTransitTime: "0000",
      maxTransitTime: "0000",
      details: [],
      arrivalAirport: "",
      departureAirport: "",
    },
    autoMatch: false,
    isIncludeManualFlight: "F",
    isIncludeSystemFlight: "T",
    isAutoMatchingManualFlight: "T",
  };
  return {
    systemTrain: {
      trainType: "1,2",
      trainCabinClass: "商务座,特等座,一等座,二等座,动卧,高级软卧,软卧,硬卧,一等卧,二等卧,软座,硬座",
      startStation: { key: "0", value: "" },
      startStations: [],
      destinationStation: { key: "0", value: "" },
      destinationStations: [],
      grabTickets: "2",
      trainEarliesTimeUnlimited: true,
      latestDepartureTimeUnlimited: true,
      earliestArrivalUnlimited: true,
      trainLatestTimeUnlimited: true,
      trainLatestDays: null,
      trainLatestTime: "",
      details: [{ trips: "", ruleType: "I" }, { trips: "", ruleType: "E" }],
    },
    isIncludeSystemTrain: "T",
  };
}
