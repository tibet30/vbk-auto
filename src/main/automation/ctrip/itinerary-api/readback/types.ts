/**
 * itinerary-api/readback 类型与字段提取 helpers：
 *   - InfoRecord / PoiRecord / HotelRecord / StationPackageRecord：info 节点的窄类型；
 *   - asInfoArray：unknown → InfoRecord[] 兜底；
 *   - poiIdOf / poiNameOf / hotelNameOf / hotelTierOf：安全字段读取；
 *   - isAttraction / isMeal / isHotel / isGather / isDismiss：按 activeType 判定节点类型；
 *   - stationCode / stationName：解析接 / 送机 / 站卡片中的 airports / trainStations 项。
 */

interface InfoRecord {
  activeType?: { key?: unknown; name?: unknown };
  description?: unknown;
  useSegmentConfig?: unknown;
  startOnBoardTime?: unknown;
  stopOnBoardTime?: unknown;
  takeoffTime?: { key?: unknown; name?: unknown };
  takeTime?: unknown;
  tourDailyPois?: Array<Record<string, unknown>>;
  tourDailyHotels?: Array<Record<string, unknown>>;
  tourDailyDinner?: {
    dinnerType?: { key?: unknown; name?: unknown };
    includeAdult?: { key?: unknown; name?: unknown };
  };
  tourDailyPackageGatherList?: StationPackageRecord[];
  tourDailyPackageDismissList?: StationPackageRecord[];
}

interface StationPackageRecord {
  airports?: unknown[];
  trainStations?: unknown[];
  serviceAllDay?: unknown;
  useCar?: { key?: unknown };
}

interface PoiRecord {
  poi?: { poiId?: unknown; poiName?: unknown };
  suffixName?: { key?: unknown; name?: unknown };
}

interface HotelRecord {
  hotel?: { hotelName?: unknown; grade?: { name?: unknown } };
}

export function asInfoArray(value: unknown): InfoRecord[] {
  if (!Array.isArray(value)) return [];
  return value as InfoRecord[];
}

export function poiIdOf(poi: PoiRecord | undefined): number {
  if (!poi?.poi) return 0;
  const id = poi.poi.poiId;
  return typeof id === "number" ? id : Number(id ?? 0);
}

export function poiNameOf(poi: PoiRecord | undefined): string {
  return String(poi?.poi?.poiName ?? "").trim();
}

export function hotelNameOf(hotel: HotelRecord | undefined): string {
  return String(hotel?.hotel?.hotelName ?? "").trim();
}

export function hotelTierOf(hotel: HotelRecord | undefined): string {
  return String(hotel?.hotel?.grade?.name ?? "").trim();
}

export function isAttraction(info: InfoRecord): boolean {
  return info.activeType?.key === 3 || info.activeType?.name === "景点";
}

export function isMeal(info: InfoRecord): boolean {
  return info.activeType?.key === 0 || info.activeType?.name === "餐饮";
}

export function isHotel(info: InfoRecord): boolean {
  return info.activeType?.key === 1 || info.activeType?.name === "酒店";
}

export function isGather(info: InfoRecord): boolean {
  return info.activeType?.key === 25 || info.activeType?.name === "集合";
}

export function isDismiss(info: InfoRecord): boolean {
  return info.activeType?.key === 26 || info.activeType?.name === "解散";
}

export function stationCode(value: unknown, kind: "air" | "train"): string {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  const record = value as Record<string, unknown>;
  return String(kind === "air" ? record.code ?? "" : record.locationCode ?? record.stationNo ?? "");
}

export function stationName(value: unknown, kind: "air" | "train"): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  const record = value as Record<string, unknown>;
  return String(kind === "air" ? record.name ?? "" : record.stationName ?? "");
}

export type { InfoRecord, PoiRecord, HotelRecord, StationPackageRecord };