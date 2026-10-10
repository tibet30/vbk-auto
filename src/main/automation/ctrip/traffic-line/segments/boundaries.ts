/**
 * 子产品资源段边界 + 多出发 / 多到达识别：
 *   - segmentsFromPayload：从 payload 的 draftProductSegments / productSegments 提取段列表；
 *   - buildBoundarySegment：用模板 + 起点 / 终点城市 + 段号生成边界段；
 *   - verifySegmentBoundaries：核验首末段为多出发 / 多到达，且首末段交通配置
 *     与 endpoints.flight / endpoints.train 一致；
 *   - verifyStationReadback：单段交通站点（抵达 / 返程）与 expected 的 code / name 对齐；
 *   - inferDestination：从首段 segmentBase 反解目的地（多出发 → destinationCity；否则 → departureCity）。
 *
 * 资源段"边界完整"是 selectTraficUnits.submitSegments 的前提；任何一段被改写都会让
 * publishSegmentModule 拒绝更新。
 */

import type { TrafficLineEndpointPlan, TrafficLineStation, TrafficLineVariant } from "../../../../../shared/contracts-traffic-line.js";
import { list, record, text, type JsonRecord } from "../client.js";

type City = JsonRecord;
type Segment = JsonRecord;

export function segmentsFromPayload(payload: JsonRecord): Segment[] {
  return list(record(payload.draftProductSegments)?.segments ?? record(payload.productSegments)?.segments);
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

export function verifySegmentBoundaries(segments: Segment[], variant: TrafficLineVariant, endpoints: TrafficLineEndpointPlan): void {
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

export function isMultiDeparture(segment: Segment): boolean { return isMultiCity(record(record(segment.segmentBase)?.departureCity)); }
export function isMultiArrival(segment: Segment): boolean { return isMultiCity(record(record(segment.segmentBase)?.destinationCity)); }
function isMultiCity(city: City | null): boolean { return text(city?.cityId) === "0"; }
export function multiCity(name: string): City { return { cityId: 0, cityName: name }; }

export function inferDestination(segments: Segment[]): City {
  const firstBase = record(segments[0]?.segmentBase);
  const firstDeparture = record(firstBase?.departureCity);
  const firstDestination = record(firstBase?.destinationCity);
  const candidate = isMultiCity(firstDeparture) ? firstDestination : firstDeparture;
  if (!candidate || !text(candidate.cityName)) throw new Error("无法从子产品资源段确定目的地城市。");
  return structuredClone(candidate);
}