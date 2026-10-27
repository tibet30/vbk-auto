/** POI 选择用的当日文本与选日辅助：只读行程，不做地域判定。 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normaliseText(value: string): string {
  return value.replace(/\s+/gu, "").trim();
}

/** 与 routeLocationsForKeyword 相同的选日规则：指定日或唯一包含该景点的日。 */
export function routeDayNumber(product: Record<string, unknown>, keyword: string, dayNumber?: number): number {
  if (dayNumber !== undefined) return dayNumber;
  const days = (Array.isArray(product.itinerary) ? product.itinerary : []).filter((day): day is Record<string, unknown> =>
    isRecord(day) && (Array.isArray(day.spots) ? day.spots : []).some(spot => isRecord(spot) && spot.name === keyword));
  return days.length === 1 ? Number(days[0]!.day) : NaN;
}

export function dayContainsKeyword(day: Record<string, unknown>, keyword: string): boolean {
  const desired = normaliseText(keyword);
  if (desired.length < 2) return false;
  const spots = Array.isArray(day.spots) ? day.spots : [];
  return spots.some((spot) => {
    if (!isRecord(spot)) return false;
    const name = normaliseText(String(spot.name ?? ""));
    return name.length >= 2 && (name.includes(desired) || desired.includes(name));
  });
}

export function dayRouteText(day: Record<string, unknown>): string {
  const spots = Array.isArray(day.spots) ? day.spots : [];
  const activities = Array.isArray(day.activities) ? day.activities : [];
  return [day.title, day.description, ...spots.flatMap((spot) => {
    if (!isRecord(spot)) return [];
    return [spot.name, spot.description];
  }), ...activities.flatMap((activity) => {
    if (!isRecord(activity)) return [];
    return [activity.title, activity.detail];
  })]
    .filter((value): value is string => typeof value === "string")
    .join(" ");
}
