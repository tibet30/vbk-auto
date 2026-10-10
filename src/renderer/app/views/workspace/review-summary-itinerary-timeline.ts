import { supportArrangementType } from "../../../../shared/itinerary-support-arrangements.js";

export interface ItineraryActivity {
  time: string;
  title: string;
  detail?: string;
  type?: "transport" | "visit" | "meal" | "hotel" | "free" | "other";
}

export interface ItineraryDay {
  day?: number;
  title?: string;
  spots?: Array<{
    name: string;
    kind?: "attraction" | "free" | "other";
    description?: string;
    poiName?: string | null;
    poiId?: number | null;
    province?: string | null;
    city?: string | null;
    district?: string | null;
  }>;
  description?: string;
  hotel?: string;
  hotelDescription?: string;
  meals?: string;
  mealDescriptions?: string[];
  activities?: ItineraryActivity[];
}

export interface TimelineItem {
  key: string;
  time: string;
  title: string;
  detail?: string;
  type: ItineraryActivity["type"];
  dayIndex: number;
  spotIndex?: number;
  poiName?: string | null;
  poiId?: number | null;
  province?: string | null;
  city?: string | null;
  district?: string | null;
  kind?: "attraction" | "free" | "other";
}

/**
 * 把 Day 的 activities 与 spots 合并成一条从上到下的时间线。
 * - activities 已有 time/Title，直接使用，按 time 升序排列；
 * - 没有 time 的 spots 视作「待安排」占位，排在末尾；
 * - 接送、餐食与住宿在独立服务区展示，不加入游览时间线。
 */
export function buildTimeline(day: ItineraryDay, dayIndex: number): TimelineItem[] {
  const activities = (day.activities ?? []).filter((item) => !["transport", "meal", "hotel"].includes(item.type ?? ""));
  const spots = (day.spots ?? []).filter(Boolean);

  const items: TimelineItem[] = [];

  const claimedSpotIndexes = new Set<number>();
  const activityItems = activities.map((act, idx) => {
    if (supportArrangementType({ name: act.title, kind: act.type }, day)) return null;
    const canAttachSpot = act.type === "visit" || act.type === undefined || act.type === "other";
    const spotIndex = canAttachSpot
      ? spots.findIndex((spot, index) => !claimedSpotIndexes.has(index) && spot.name.trim() === act.title.trim())
      : -1;
    const spot = spotIndex >= 0 ? spots[spotIndex] : undefined;
    if (spotIndex >= 0) claimedSpotIndexes.add(spotIndex);
    return {
      key: `act-${idx}`,
      time: act.time || "",
      title: act.title,
      detail: act.detail,
      type: spot ? (spot.kind === "free" ? "free" : spot.kind === "other" ? "other" : "visit") : act.type ?? "other",
      dayIndex,
      spotIndex: spotIndex >= 0 ? spotIndex : undefined,
      poiName: spot?.poiName ?? null,
      poiId: spot?.poiId ?? null,
      province: spot?.province ?? null,
      city: spot?.city ?? null,
      district: spot?.district ?? null,
      kind: spot?.kind,
    };
  }).filter((item): item is NonNullable<typeof item> => Boolean(item));

  // spots 未在 activities 里出现的，追加到末尾作为未排时间的景点。
  const usedTitles = new Set(activityItems.map((a) => a.title.trim()));
  const spotItems: TimelineItem[] = spots
    .map((spot, index) => ({ spot, index }))
    .filter(({ spot, index }) => !claimedSpotIndexes.has(index) && !usedTitles.has(spot.name.trim()) && !supportArrangementType(spot, day))
    .map<TimelineItem>(({ spot, index }) => ({
      key: `spot-${index}`,
      time: "",
      title: spot.name,
      detail: spot.description,
      type: spot.kind === "free" ? "free" : spot.kind === "other" ? "other" : "visit",
      dayIndex,
      spotIndex: index,
      poiName: spot.poiName ?? null,
      poiId: spot.poiId ?? null,
      province: spot.province ?? null,
      city: spot.city ?? null,
      district: spot.district ?? null,
      kind: spot.kind,
    }));

  items.push(...activityItems, ...spotItems);

  // 按 time 升序排序（有 time 的排前）。
  items.sort((a, b) => {
    const at = parseTimeOrInfinity(a.time);
    const bt = parseTimeOrInfinity(b.time);
    return at - bt;
  });

  return items;
}

function parseTimeOrInfinity(raw: string): number {
  const match = raw.match(/^(\d{1,2}):?(\d{2})?$/);
  if (!match) return Number.POSITIVE_INFINITY;
  const hours = Number(match[1]);
  const minutes = Number(match[2] ?? 0);
  if (Number.isNaN(hours) || Number.isNaN(minutes)) return Number.POSITIVE_INFINITY;
  return hours * 60 + minutes;
}
