/**
 * traffic-line/itinerary.ts（predicates 子模块）：
 *   判定 flight / train 节点是否"可用"的小谓词。
 *   - hasFlightCard / hasTrainCard：节点至少有一个可用的 package 或 legacy 卡片；
 *   - hasUsablePackageFlight / hasUsableLegacyFlight：航班卡片有 flightNo / 出发到达站；
 *   - hasUsablePackageTrain / hasUsableLegacyTrain：火车卡片有 trainNo / 出发到达站；
 *   - hasNamedCode：通用"是否有命名/代号"判定，覆盖 code / name / locationCode / stationName。
 */

import { list, record, text, type JsonRecord } from "../client.js";

export function hasFlightCard(node: JsonRecord): boolean {
  return list(node.tourDailyPackageFlights).some(hasUsablePackageFlight)
    || list(node.tourDailyFlights).some((item) => hasUsableLegacyFlight(record(item.flight)));
}

export function hasTrainCard(node: JsonRecord): boolean {
  return list(node.tourDailyPackageTrains).some(hasUsablePackageTrain)
    || list(node.tourDailyTrains).some((item) => hasUsableLegacyTrain(record(item.train)));
}

export function hasUsablePackageFlight(card: JsonRecord): boolean {
  return Boolean(text(card.flightNo))
    || list(card.departureAirports).some(hasNamedCode)
    || list(card.arriveAirports).some(hasNamedCode)
    || Boolean(text(card.departureLocation))
    || Boolean(text(card.arriveLocation));
}

export function hasUsableLegacyFlight(flight: JsonRecord | null): boolean {
  if (!flight) return false;
  return Boolean(text(flight.flightNo))
    || hasNamedCode(record(flight.departureAirport))
    || hasNamedCode(record(flight.arriveAirport))
    || Boolean(text(flight.departureAirportName))
    || Boolean(text(flight.arriveAirportName));
}

export function hasUsablePackageTrain(card: JsonRecord): boolean {
  return Boolean(text(card.trainNo))
    || list(card.departureStationList).some(hasNamedCode)
    || list(card.arriveStationList).some(hasNamedCode)
    || list(card.departureTrainStations).some(hasNamedCode)
    || list(card.arriveTrainStations).some(hasNamedCode)
    || Boolean(text(card.departureLocation))
    || Boolean(text(card.arriveLocation));
}

export function hasUsableLegacyTrain(train: JsonRecord | null): boolean {
  if (!train) return false;
  return Boolean(text(train.trainNo))
    || Boolean(text(train.departureStation))
    || Boolean(text(train.arriveStation));
}

/** 通用"是否有命名/代号"判定，覆盖 code / name / locationCode / stationName。 */
export function hasNamedCode(value: JsonRecord | null): boolean {
  if (!value) return false;
  return Boolean(text(value.code) || text(value.name) || text(value.locationCode) || text(value.stationName));
}