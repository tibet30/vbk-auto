import type { ProductDetail } from "../../shared/contracts.js";
import { hasTrustedOperatorAlternativeDeletion } from "./itinerary-input-contract.js";

type JsonObject = Record<string, unknown>;

export interface ExplicitAlternativeSpotRestore {
  day: number;
  name: string;
  /** The exact original OR group, when this slot belongs to one. */
  group?: ExplicitAlternativeGroupRestore;
  /** Exact preceding input slot, when one exists. */
  after?: string;
  /** Exact following input slot, when one exists. */
  before?: string;
}

export interface ExplicitAlternativeGroupRestore {
  day: number;
  names: string[];
}

/**
 * Expands one locked route slot from structured intent into its exact OR
 * names. It only expands a unique, exact group anchor; ordinary absent POIs
 * must continue through readiness instead of being invented here.
 */
export function expandExplicitAlternativeGroupOrder(
  order: readonly string[],
  group: ExplicitAlternativeGroupRestore,
): string[] {
  const names = uniqueNames(group.names);
  if (names.length < 2) return [...order];
  const matches = order.flatMap((spot, index) => names.some((name) => samePlace(spot, name)) ? [index] : []);
  if (matches.length !== 1) return [...order];
  const index = matches[0]!;
  return [...order.slice(0, index), ...names, ...order.slice(index + 1)];
}

/** Restore only named members of one explicit OR group, using expanded locked order. */
export function restoreExplicitAlternativeGroupSpots(
  product: ProductDetail,
  itinerary: unknown,
  order: readonly string[],
  group: ExplicitAlternativeGroupRestore,
): { itinerary: JsonObject[]; changed: boolean } {
  const expanded = expandExplicitAlternativeGroupOrder(order, group);
  let next: unknown = itinerary;
  let changed = false;
  for (let index = 0; index < expanded.length; index += 1) {
    const name = expanded[index]!;
    if (!group.names.some((member) => samePlace(member, name))) continue;
    const result = restoreMissingExplicitAlternativeSpots(product, next, {
      day: group.day,
      name,
      group,
      ...(index > 0 ? { after: expanded[index - 1] } : {}),
      ...(index + 1 < expanded.length ? { before: expanded[index + 1] } : {}),
    });
    next = result.itinerary;
    changed = changed || result.changed;
  }
  return { itinerary: next as JsonObject[], changed };
}

/**
 * Restore an explicitly named alternative that disappeared without a trusted
 * operator deletion.  This is deliberately structural: it neither invents a
 * POI mapping nor edits accommodation, services, or itinerary copy.
 */
export function restoreMissingExplicitAlternativeSpots(
  product: ProductDetail,
  itinerary: unknown,
  restore: ExplicitAlternativeSpotRestore,
): { itinerary: JsonObject[]; changed: boolean } {
  const next = Array.isArray(itinerary) ? itinerary.filter(isRecord).map((day) => structuredClone(day)) : [];
  if (hasTrustedOperatorAlternativeDeletion(product, restore.day, restore.name, restore.group)) {
    return { itinerary: next, changed: JSON.stringify(itinerary) !== JSON.stringify(next) };
  }
  const day = next.find((item) => Number(item.day) === restore.day);
  const spots = Array.isArray(day?.spots) ? day.spots.filter(isRecord) : [];
  if (!day || !restore.name.trim() || spots.some((spot) => samePlace(spotName(spot), restore.name))) {
    return { itinerary: next, changed: JSON.stringify(itinerary) !== JSON.stringify(next) };
  }
  const after = text(restore.after);
  const before = text(restore.before);
  if (!after && !before) return { itinerary: next, changed: JSON.stringify(itinerary) !== JSON.stringify(next) };
  const afterIndex = after ? spots.findIndex((spot) => samePlace(spotName(spot), after)) : -1;
  const beforeIndex = before ? spots.findIndex((spot) => samePlace(spotName(spot), before)) : -1;
  if ((after && afterIndex < 0) || (before && beforeIndex < 0)
    || (after && before && beforeIndex !== afterIndex + 1)) {
    return { itinerary: next, changed: JSON.stringify(itinerary) !== JSON.stringify(next) };
  }
  // A single anchor is valid only for a first/last input slot whose order the
  // caller already determined from the locked alternative group.
  const neighborIndex = after ? afterIndex : beforeIndex;
  const neighbor = spots[neighborIndex]!;
  const timeOfDay = text(neighbor.timeOfDay);
  neighbor.relation = "or";
  spots.splice(after ? afterIndex + 1 : beforeIndex, 0, {
    name: restore.name.trim(),
    kind: "attraction",
    poiName: null,
    poiId: null,
    ...(timeOfDay ? { timeOfDay } : {}),
    relation: "or",
  });
  day.spots = spots;
  return { itinerary: next, changed: true };
}

function spotName(value: JsonObject): string { return text(value.name) || text(value.poiName); }
function samePlace(left: string, right: string): boolean {
  const a = left.replace(/\s+/g, "");
  const b = right.replace(/\s+/g, "");
  // Slot restoration changes ordering, so anchors must identify the exact
  // named entry.  Copy aliases are deliberately confined to receipt-backed
  // presentation repair and never authorize structural restoration.
  return Boolean(a) && a === b;
}
function uniqueNames(names: readonly string[]): string[] {
  const result: string[] = [];
  for (const name of names) {
    const value = text(name);
    if (value && !result.some((current) => samePlace(current, value))) result.push(value);
  }
  return result;
}
function isRecord(value: unknown): value is JsonObject { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function text(value: unknown): string { return typeof value === "string" ? value.trim() : ""; }
