import { poiNameKey } from "./poi-name-key.js";
import { requiresItineraryPoi } from "./itinerary-activity-kind.js";
import { isKnownPoiNameAlias } from "./poi-name-aliases.js";

type Json = Record<string, unknown>;

type SeenSpot = {
  index: number;
  name: string;
  timeOfDay: unknown;
  poiId: number | null;
  poiNameKeys: string[];
  hasProviderIdentity: boolean;
};

/**
 * Collapse repeated copies of the same named visit after provider resolution.
 *
 * A provider ID never authorises merging distinct original names. Different
 * route labels, visit periods, provider IDs, days and explicit OR alternatives
 * remain separate, so their individual verification tasks retain a real slot.
 */
export function dedupeSameDayItinerarySpots(spots: readonly unknown[]): unknown[] {
  const result: unknown[] = [];
  const seen: SeenSpot[] = [];

  for (const spot of spots) {
    const current = record(spot);
    if (!current || current.relation === "or" || !requiresItineraryPoi(current)) {
      result.push(spot);
      continue;
    }
    const identity = spotIdentity(current);
    const duplicate = seen.find((candidate) => sameIdentity(candidate, identity));
    if (!duplicate) {
      seen.push({ index: result.length, ...identity });
      result.push(spot);
      continue;
    }
    const retained = record(result[duplicate.index]);
    if (!retained) continue;
    preferAttractionLabel(retained, current);
    mergeMissingPoiMetadata(retained, current);
    const mergedIdentity = spotIdentity(retained);
    duplicate.poiId = mergedIdentity.poiId;
    duplicate.poiNameKeys = mergedIdentity.poiNameKeys;
  }

  return result;
}

function preferAttractionLabel(target: Json, source: Json): void {
  if (!isAdministrativeLabel(target) || isAdministrativeLabel(source)) return;
  if (typeof source.name === "string" && source.name.trim()) target.name = source.name;
}

function isAdministrativeLabel(spot: Json): boolean {
  const name = poiNameKey(spot.name);
  if (!name) return false;
  return [spot.province, spot.city, spot.district]
    .some((administrativeName) => name === poiNameKey(administrativeName));
}

/** Apply same-day POI deduplication without mutating the caller's product. */
export function dedupeProductItineraryPois<T extends Json>(product: T): T {
  if (!Array.isArray(product["itinerary"])) return product;
  const next = structuredClone(product);
  (next as Json)["itinerary"] = (next["itinerary"] as unknown[]).map((day) => {
    const value = record(day);
    if (!value || !Array.isArray(value.spots)) return day;
    value.spots = dedupeSameDayItinerarySpots(value.spots);
    return value;
  });
  return next;
}

function sameIdentity(left: Omit<SeenSpot, "index">, right: Omit<SeenSpot, "index">): boolean {
  // Provider identity does not authorise deleting a distinct original route label or visit.
  if (left.name !== right.name || left.timeOfDay !== right.timeOfDay) return false;
  if (left.poiId && right.poiId) return left.poiId === right.poiId;
  return left.poiNameKeys.some((leftName) => right.poiNameKeys.some((rightName) =>
    leftName === rightName || ((left.hasProviderIdentity && right.hasProviderIdentity)
      && isKnownPoiNameAlias(leftName, rightName))));
}

function spotIdentity(spot: Json): Omit<SeenSpot, "index"> {
  const providerName = poiNameKey(spot.poiName);
  return {
    // Unlike provider identity, an original visit label includes its notes/actions.
    name: typeof spot.name === 'string' ? spot.name.replace(/\s+/gu, '').trim() : '',
    timeOfDay: spot.timeOfDay,
    poiId: positiveInteger(spot.poiId),
    poiNameKeys: [providerName, poiNameKey(spot.name)].filter(Boolean),
    hasProviderIdentity: Boolean(providerName || positiveInteger(spot.poiId)),
  };
}

function mergeMissingPoiMetadata(target: Json, source: Json): void {
  for (const key of ["poiName", "poiId", "province", "city", "district", "description"] as const) {
    if (isMissing(target[key]) && !isMissing(source[key])) target[key] = source[key];
  }
}

function isMissing(value: unknown): boolean {
  return value === undefined || value === null || (typeof value === "string" && !value.trim());
}

function positiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

function record(value: unknown): Json | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Json : undefined;
}
