import type { PoiSuggestContext } from "./types.js";
import { hasCompletePoi } from "../../shared/itinerary-activity-kind.js";
import { toPlatformShortLocationName } from "../../shared/location-short-name.js";
import { originalOvernightRoute } from "../../shared/itinerary-overnight-city.js";

/**
 * 按 POI / 景点 / 景区名称从一天的文本中反推城市。
 *
 * 数据目前以潮州片区为业务范围；使用逻辑（命中多个不取）是通用的，
 * 需要扩展其它区域时按同一格式追加即可。
 */
const CITY_NAME_HINTS: Array<{ city: string; markers: RegExp[] }> = [
  { city: "潮州", markers: [/潮州/u, /湘桥/u, /广济桥/u, /牌坊街/u, /开元寺/u] },
  { city: "汕头", markers: [/汕头/u, /南澳/u, /小公园/u, /澄海/u, /龙湖/u] },
  { city: "揭阳", markers: [/揭阳/u, /榕城/u, /普宁/u] },
];

export function buildPoiContext(product: Record<string, unknown>, destination: string): PoiSuggestContext {
  const basic = productBasicInfo(product);
  return {
    destinationCity: textValue(basic.destinationCity) || textValue(basic.meetingCity) || destination,
    province: textValue(basic.province) || destination,
  };
}

export function buildPoiContextForItineraryDay(
  product: Record<string, unknown>,
  destination: string,
  day: unknown,
): PoiSuggestContext {
  const base = buildPoiContext(product, destination);
  const sameDay = verifiedOriginalRouteLocation(product, day);
  if (sameDay) return sameDay;
  const dayCity = inferExplicitPoiDayCity(day);
  if (dayCity) return { ...base, destinationCity: dayCity };
  return verifiedSurroundingRouteLocation(product, day) ?? base;
}

type VerifiedRouteLocation = { destinationCity: string; province: string };

function verifiedSurroundingRouteLocation(
  product: Record<string, unknown>,
  targetDay: unknown,
): VerifiedRouteLocation | undefined {
  if (!Array.isArray(product.itinerary)) return undefined;
  const targetNumber = isRecord(targetDay) ? Number(targetDay.day) : NaN;
  const targetIndex = product.itinerary.findIndex((item) => item === targetDay
    || (Number.isInteger(targetNumber) && isRecord(item) && Number(item.day) === targetNumber));
  if (targetIndex <= 0 || targetIndex >= product.itinerary.length - 1) return undefined;
  const before = verifiedOriginalRouteLocation(product, product.itinerary[targetIndex - 1]);
  const after = verifiedOriginalRouteLocation(product, product.itinerary[targetIndex + 1]);
  return before && after && sameRouteLocation(before, after) ? before : undefined;
}

function verifiedOriginalRouteLocation(
  product: Record<string, unknown>,
  day: unknown,
): VerifiedRouteLocation | undefined {
  if (!isRecord(day)) return undefined;
  const dayNumber = Number(day.day);
  const rawRoute = Number.isInteger(dayNumber) ? normaliseText(originalOvernightRoute(product, day)) : "";
  if (!rawRoute || !Array.isArray(day.spots)) return undefined;
  const complete = day.spots.filter((spot): spot is Record<string, unknown> => isRecord(spot) && hasCompletePoi(spot));
  if (!complete.length || complete.some((spot) => !originalRouteSupportsSpot(rawRoute, spot))) return undefined;
  const verified = complete;
  if (!verified.length) return undefined;
  const locations = verified.map((spot) => ({
    destinationCity: toPlatformShortLocationName(spot.city),
    province: toPlatformShortLocationName(spot.province),
  }));
  if (locations.some((location) => !location.destinationCity || !location.province)) return undefined;
  const productProvince = toPlatformShortLocationName(productBasicInfo(product).province);
  if (productProvince && locations.some((location) => location.province !== productProvince)) return undefined;
  const [first] = locations;
  return first && locations.every((location) => sameRouteLocation(first, location)) ? first : undefined;
}

function originalRouteSupportsSpot(rawRoute: string, spot: Record<string, unknown>): boolean {
  const name = normaliseText(spot.name);
  const locations = [spot.city, spot.district]
    .flatMap((value) => [normaliseText(value), normaliseText(toPlatformShortLocationName(value))])
    .filter((value) => value.length >= 2);
  return name.length >= 2 && rawRoute.includes(name) && locations.some((location) => rawRoute.includes(location));
}

function sameRouteLocation(left: VerifiedRouteLocation, right: VerifiedRouteLocation): boolean {
  return left.destinationCity === right.destinationCity && left.province === right.province;
}

export function hasProductPoiContext(product: Record<string, unknown>): boolean {
  const basic = productBasicInfo(product);
  return Boolean(textValue(basic.destinationCity) || textValue(basic.meetingCity) || textValue(basic.province));
}

export function inferExplicitPoiDayCity(day: unknown): string | undefined {
  // 接团城市与游览城市可能同时出现在交通说明中；先以游览标题和景点为准。
  if (isRecord(day)) {
    const spots = Array.isArray(day.spots) ? day.spots : [];
    const visitText = [day.title, ...spots.map((spot) => typeof spot === "string" ? spot : isRecord(spot) ? spot.name || spot.poiName : "")]
      .filter((value): value is string => typeof value === "string").join(" ");
    const visitCities = CITY_NAME_HINTS.filter((hint) => hint.markers.some((marker) => marker.test(visitText)));
    if (visitCities.length === 1) return visitCities[0].city;
  }
  const text = itineraryDayText(day);
  if (!text) return undefined;
  const matches = CITY_NAME_HINTS
    .filter((hint) => hint.markers.some((marker) => marker.test(text)))
    .map((hint) => hint.city);
  const unique = [...new Set(matches)];
  return unique.length === 1 ? unique[0] : undefined;
}

function itineraryDayText(day: unknown): string {
  if (!isRecord(day)) return "";
  const spots = Array.isArray(day.spots) ? day.spots : [];
  return [day.title, day.description, ...spots.flatMap((spot) => {
    if (typeof spot === "string") return [spot];
    if (!isRecord(spot)) return [];
    return [spot.name, spot.poiName, spot.description, spot.note, spot.remark];
  })]
    .filter((value): value is string => typeof value === "string")
    .join(" ");
}

function productBasicInfo(product: Record<string, unknown>): Record<string, unknown> {
  return product.basicInfo && typeof product.basicInfo === "object" && !Array.isArray(product.basicInfo)
    ? product.basicInfo as Record<string, unknown>
    : {};
}

function textValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normaliseText(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/gu, "").trim() : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
