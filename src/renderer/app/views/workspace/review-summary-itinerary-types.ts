export interface ItineraryTimelineSpotItem {
  title: string;
  dayIndex: number;
  spotIndex: number;
  poiName?: string | null;
  poiId?: number | null;
  province?: string | null;
  city?: string | null;
  district?: string | null;
}

/** 省/市/区紧凑展示：西藏/日喀则/江孜；缺省返回 null。 */
export function formatPoiRegion(parts: {
  province?: string | null;
  city?: string | null;
  district?: string | null;
}): string | null {
  const values = [parts.province, parts.city, parts.district]
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value));
  const compact: string[] = [];
  for (const value of values) {
    if (compact[compact.length - 1] === value) continue;
    compact.push(value);
  }
  return compact.length > 0 ? compact.join("/") : null;
}
