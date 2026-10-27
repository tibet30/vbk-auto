/**
 * 运营原文逐日路线里明确写出的城市，是旧产品缺失 routeLocations 时的地点证据。
 * 只接受「当天唯一景点 + 完整路线节点 + 候选城市也被当天原文点名」；生成标题、
 * 酒店和旧 POI 绑定都不参与，避免为跨省自动绑定放宽门禁。
 */
import type { PoiSuggestCandidate } from "../../shared/contracts-types.js";
import { originalOvernightRoute } from "../../shared/original-itinerary-route.js";
import { orderedItineraryRoutePath } from "../../shared/itinerary-route-path.js";
import { toPlatformShortLocationName } from "../../shared/location-short-name.js";

type Json = Record<string, unknown>;

export function explicitOriginalRouteDecision(
  product: Json,
  keyword: string,
  candidate: PoiSuggestCandidate,
  candidates?: PoiSuggestCandidate[],
): "allow" | "deny" | undefined {
  if (!Array.isArray(product.itinerary)) return undefined;
  const desired = normaliseText(keyword);
  const days = product.itinerary.filter((day): day is Json => isRecord(day)
    && (Array.isArray(day.spots) ? day.spots : []).some((spot) => isRecord(spot)
      && (normaliseText(String(spot.name ?? "")) === desired || normaliseText(String(spot.poiName ?? "")) === desired)));
  // 同名景点跨多日时，单条路线不能替另一天作证。
  if (days.length !== 1) return undefined;
  const route = originalOvernightRoute(product, days[0]!);
  if (!route) return undefined;
  const path = orderedItineraryRoutePath(route).replace(/\s+/gu, "");
  if (!path || !routeContainsWholeStop(path, desired)) return undefined;
  if (!routeOrderPreserved(path, days[0]!)) return undefined;
  const city = toPlatformShortLocationName(candidate.city).replace(/\s+/gu, "");
  if (!city) return undefined;
  const keywordPosition = routeStopIndex(path, desired)!;
  const candidateCities = new Set((candidates ?? []).map((item) => toPlatformShortLocationName(item.city).replace(/\s+/gu, ""))
    .filter((name): name is string => Boolean(name)));
  if (!candidateCities.size) candidateCities.add(city);
  const distances = [...candidateCities].flatMap((name) => {
    const distance = nearestOccurrenceDistance(path, name, keywordPosition);
    return distance === undefined ? [] : [{ name, distance }];
  });
  if (!distances.length) return undefined;
  const own = distances.find((item) => item.name === city);
  if (!own) return "deny";
  return own.distance <= Math.min(...distances.map((item) => item.distance)) ? "allow" : "deny";
}

/** 候选城市必须在路线中离当前景点最近；同日途经的其它城市不能替它作证。 */
function nearestOccurrenceDistance(path: string, name: string, position: number): number | undefined {
  let best: number | undefined;
  for (let index = path.indexOf(name); index >= 0; index = path.indexOf(name, index + name.length)) {
    const distance = Math.abs(index - position);
    if (best === undefined || distance < best) best = distance;
  }
  return best;
}

function routeContainsWholeStop(path: string, name: string): boolean {
  const boundary = (character: string | undefined) =>
    character === undefined || /[-—–→+＋>＞，,、/／（(【:：&＆\s]/u.test(character);
  for (let index = path.indexOf(name); index >= 0; index = path.indexOf(name, index + name.length)) {
    if (boundary(path[index - 1]) && boundary(path[index + name.length])) return true;
  }
  return false;
}

/** 景点顺序被整体打乱时，原路线不能再替当前行程作证。 */
function routeOrderPreserved(path: string, day: Json): boolean {
  const spots = Array.isArray(day.spots) ? day.spots : [];
  const positions = spots.flatMap((spot) => {
    if (!isRecord(spot)) return [];
    const name = normaliseText(String(spot.name ?? spot.poiName ?? ""));
    if (!name) return [];
    const position = routeStopIndex(path, name);
    return position === undefined ? [] : [position];
  });
  return positions.every((position, index) => index === 0 || position >= positions[index - 1]!);
}

function routeStopIndex(path: string, name: string): number | undefined {
  const boundary = (character: string | undefined) =>
    character === undefined || /[-—–→+＋>＞，,、/／（(【:：&＆\s]/u.test(character);
  for (let index = path.indexOf(name); index >= 0; index = path.indexOf(name, index + name.length)) {
    if (boundary(path[index - 1]) && boundary(path[index + name.length])) return index;
  }
  return undefined;
}

function normaliseText(value: string): string {
  return value.replace(/\s+/gu, "").trim();
}
function isRecord(value: unknown): value is Json {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
