import type { PoiSuggestContext } from "./types.js";

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
  const dayCity = inferExplicitPoiDayCity(day);
  return dayCity ? { ...base, destinationCity: dayCity } : base;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
