/** Canonical meaning of one ordered itinerary entry.  This is deliberately
 * independent of POI lookup: a lookup failure never changes an attraction. */
export type ItineraryActivityKind = "attraction" | "free" | "other";

export type ItinerarySpotLike = {
  name?: unknown;
  kind?: unknown;
  description?: unknown;
  poiId?: unknown;
  poiName?: unknown;
  remark?: unknown;
};

export const RETAINED_TEXT_ONLY_POI_REMARK = "已保留原景点和原行程位置，仅以文字录入";
export const RETAINED_TEXT_ONLY_DETAIL_PATTERN = /已保留原景点和原行程位置/u;

/** Only an explicit retained-text marker changes how an unresolved spot is written. */
export function effectiveItinerarySpotKind(spot: ItinerarySpotLike): ItineraryActivityKind {
  if (!hasCompletePoi(spot) && text(spot.remark).includes(RETAINED_TEXT_ONLY_POI_REMARK)) return "other";
  return itinerarySpotKind(spot);
}

const SERVICE_ACTIVITY = /(接团|送团|接机|送机|接站|送站|接送|航拍|无人机|办理入住|集合|解散|乘车|返程)/u;
const PLACE_SUFFIX = /(博物馆|纪念馆|美术馆|科技馆|文化馆|展览馆|图书馆|剧院|戏楼|书院|古镇|古城|古街|老街|步行街|小吃街|一条街|街区|景区|风景区|公园|广场|山|湖|寺|观|宫|城墙|遗址|陵|社)$/u;

export function itinerarySpotKind(spot: ItinerarySpotLike): ItineraryActivityKind {
  if (spot.kind === "attraction" || spot.kind === "free" || spot.kind === "other") return spot.kind;
  const name = text(spot.name);
  // Historical, already verified POIs and named places stay attractions even
  // when their title carries an experience/free-activity suffix.
  if (hasCompletePoi(spot) || namedPoiPrefix(name)) return "attraction";
  if (/^(?:上午|下午|晚上|全天)?\s*自由活动$/u.test(name)) return "free";
  if (SERVICE_ACTIVITY.test(name)) return "other";
  return "attraction";
}

export function requiresItineraryPoi(spot: ItinerarySpotLike): boolean {
  return effectiveItinerarySpotKind(spot) === "attraction";
}

export function hasCompletePoi(spot: ItinerarySpotLike): boolean {
  return text(spot.poiName).length > 0 && Number.isInteger(spot.poiId) && Number(spot.poiId) > 0;
}

export function itineraryAttractions<T extends ItinerarySpotLike>(spots: readonly T[] | undefined): T[] {
  return (spots ?? []).filter((spot) => requiresItineraryPoi(spot));
}

export function normaliseItinerarySpotKind<T extends ItinerarySpotLike>(spot: T): T & { kind: ItineraryActivityKind; poiId: number | null; poiName: string | null } {
  const kind = itinerarySpotKind(spot);
  if (kind !== "attraction") return { ...spot, kind, relation: "and", poiId: null, poiName: null };
  return { ...spot, kind, poiId: Number.isInteger(spot.poiId) && Number(spot.poiId) > 0 ? Number(spot.poiId) : null, poiName: text(spot.poiName) || null };
}

function namedPoiPrefix(title: string): string | undefined {
  const prefix = title.replace(/^(?:游览|参观|打卡|前往|去|到)\s*/u, "")
    .split(/[【\[]/, 1)[0]
    .replace(/(?:自由活动|体验|手作|制作|课程|休息|用餐|入住|接送|乘车|集合|离开|返程).*$/u, "")
    .trim();
  return PLACE_SUFFIX.test(prefix) ? prefix : undefined;
}

function text(value: unknown): string { return typeof value === "string" ? value.trim() : ""; }
