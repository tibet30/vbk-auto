import { hotelStayRequirement } from "./hotel-stay-requirement.js";
import { hasCompletePoi } from "./itinerary-activity-kind.js";
import { toWritableAdministrativeCityName } from "./region-overrides.js";

type JsonObject = Record<string, unknown>;

const PROTECTED_PLACE_SUFFIX = /(?:景区|古镇|城区|园区|片区|街区|社区|校区|厂区|矿区|库区)$/u;

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
  if (!value || PROTECTED_PLACE_SUFFIX.test(value)) return false;
  if (/^\d+道班$/u.test(value)) return true;
  if (!product || !routeTitleContainsNode(text(day.title), value)) return false;

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
  const itinerary = Array.isArray(product.itinerary) ? product.itinerary.filter(isRecord) : [];
  for (const targetDay of [dayNumber, dayNumber - 1]) {
    const sourceDay = itinerary.find((item) => Number(item.day) === targetDay) ?? { day: targetDay };
    const requirement = hotelStayRequirement(product, sourceDay);
    if (requirement) administrative.push(requirement.anchorName, requirement.cityName ?? "");
  }

  const writableName = toWritableAdministrativeCityName(value);
  return administrative.some((candidate) => candidate === value
    || toWritableAdministrativeCityName(candidate) === writableName);
}

function routeTitleContainsNode(title: string, name: string): boolean {
  return new RegExp(`(?:^|[—→·-])\\s*${escapeRegExp(name)}\\s*(?:[—→·-]|$)`, "u").test(title);
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
