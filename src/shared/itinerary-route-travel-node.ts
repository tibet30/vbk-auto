import { hasCompletePoi } from "./itinerary-activity-kind.js";
import { originalOvernightRoute } from "./itinerary-overnight-city.js";
import { toWritableAdministrativeCityName } from "./region-overrides.js";
import { isProtectedRoutePoiPlaceName } from "./route-place-name.js";

type JsonObject = Record<string, unknown>;

/**
 * Identify a persisted route/lodging node that must stay in the route text but
 * must not be written to VBK as a POI. The title check prevents a same-named
 * attraction from being removed merely because it resembles a city or village.
 */
export function isPersistedRouteTravelNode(
  product: JsonObject | undefined,
  day: JsonObject,
  name: string,
): boolean {
  const value = name.trim();
  if (!value) return false;
  if (/^\d+道班$/u.test(value)) return true;
  if (!product || !routeTitleContainsNode(text(day.title), value)) return false;
  if (hasOriginalLodgingDeparture(product, day, value)) return true;
  if (isProtectedRoutePoiPlaceName(value)) {
    return hasExplicitPreviousOvernightStart(product, day, value);
  }

  const basic = isRecord(product.basicInfo) ? product.basicInfo : {};
  const administrative = [basic.meetingCity, basic.destinationCity, basic.destination]
    .map(text)
    .filter(Boolean);
  const spots = Array.isArray(day.spots) ? day.spots.filter(isRecord) : [];
  for (const peer of spots) {
    if (!hasCompletePoi(peer) || text(peer.name) === value) continue;
    administrative.push(text(peer.province), text(peer.city), text(peer.district));
  }
  const dayNumber = Number(day.day);
  for (const targetDay of [dayNumber, dayNumber - 1]) {
    const overnight = explicitOriginalOvernightName(originalOvernightRoute(product, { day: targetDay }));
    if (overnight) administrative.push(overnight);
  }

  const writableName = toWritableAdministrativeCityName(value);
  return administrative.some((candidate) => candidate === value
    || toWritableAdministrativeCityName(candidate) === writableName);
}

/** A bare departure is not a POI only when the preceding original day ends
 * with that exact lodging locality and today's original route starts there.
 * This is role evidence, never administrative or POI identity evidence. */
function hasOriginalLodgingDeparture(product: JsonObject, day: JsonObject, name: string): boolean {
  const currentSpots = Array.isArray(day.spots) ? day.spots.filter(isRecord) : [];
  if (currentSpots.some(spot => text(spot.name) === name && hasCompletePoi(spot))) return false;

  if (isProtectedRoutePoiPlaceName(name)
    || /(?:山|湖|寺|公园|博物馆|纪念馆|古城|市集|广场|遗址)$/u.test(name)) return false;
  const dayNumber = Number(day.day);
  if (!Number.isInteger(dayNumber) || dayNumber <= 1) return false;
  const previous = originalOvernightRoute(product, { day: dayNumber - 1 });
  const endpoint = previous?.split(/[-—–→]/u).at(-1)?.trim();
  const locality = endpoint?.match(/^([^，,。；;（）()]{2,10}?)(?:温泉)?(?:酒店|宾馆|住宿)[。；;]?$/u)?.[1];
  if (locality !== name) return false;
  const current = originalOvernightRoute(product, { day: dayNumber });
  return current?.replace(/^\s*[:：]/u, '').split(/[-—–→]/u)[0]?.trim() === name;
}

function hasExplicitPreviousOvernightStart(product: JsonObject, day: JsonObject, name: string): boolean {
  const dayNumber = Number(day.day);
  if (!Number.isInteger(dayNumber) || dayNumber <= 1) return false;
  const previous = explicitOriginalOvernightName(originalOvernightRoute(product, { day: dayNumber - 1 }));
  if (previous !== name) return false;
  const current = originalOvernightRoute(product, { day: dayNumber });
  const start = current?.replace(/^\s*[:：]/u, "").split(/[-—–→]/u)[0]?.trim();
  return start === name;
}

function explicitOriginalOvernightName(source: string | undefined): string | undefined {
  if (!source) return undefined;
  return source.match(/[（(]\s*宿\s*([^）)]+)[）)]/u)?.[1]?.trim()
    || source.match(/(?:住宿|入住|住(?!宿))\s*(?:为|：|:)?\s*([^—–\-，,、。；;\n（(]{2,30})/u)?.[1]?.trim();
}

function routeTitleContainsNode(title: string, name: string): boolean {
  // 私家团标题「专车服务｜大理-丽江」里，「｜」后的首个节点同样是独立路线节点。
  return new RegExp(`(?:^|[—→·｜-])\\s*${escapeRegExp(name)}\\s*(?:[—→·-]|$)`, "u").test(title);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function isRecord(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
