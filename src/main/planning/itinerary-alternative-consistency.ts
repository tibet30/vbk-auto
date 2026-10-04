import type { ProductDetail } from "../../shared/contracts.js";
import {
  alternativeMentionAliases,
  containsExcludedAlternativeMention,
  excludedItineraryAlternativeGroups,
} from "./itinerary-alternative-copy.js";

type Json = Record<string, unknown>;

/** Derived copy may only describe the active itinerary after an OR group converges. */
export function excludedItineraryCopyConflicts(product: ProductDetail, extraCopy: readonly string[] = []): string[] {
  const itinerary = Array.isArray(product.product.itinerary) ? product.product.itinerary : [];
  const excluded = excludedItineraryAlternativeGroups(product, itinerary);
  if (!excluded.length) return [];
  const presentation = record(product.product.presentation);
  const globalCopy = [
    text(presentation?.recommendation), text(presentation?.features),
    ...(Array.isArray(presentation?.recommendations) ? presentation!.recommendations.map((item) => text(record(item)?.text)) : []),
    ...extraCopy,
  ].filter(Boolean);
  const activeEverywhere = itinerary.flatMap((day) => {
    const current = record(day);
    return Array.isArray(current?.spots) ? current.spots.map((spot) => text(record(spot)?.name)) : [];
  });
  const conflicts: string[] = [];
  for (const { day, names } of excluded) {
    const current = itinerary.find((item) => Number(record(item)?.day) === day);
    const currentDay = record(current);
    const dayCopy = [text(currentDay?.title), text(currentDay?.description)].filter(Boolean);
    const activeDay = Array.isArray(currentDay?.spots)
      ? currentDay.spots.map((spot) => text(record(spot)?.name))
      : [];
    for (const name of names) {
      if (containsExcluded(dayCopy, name, activeDay) || containsExcluded(globalCopy, name, activeEverywhere)) conflicts.push(`第${day}天「${name}」`);
    }
  }
  return [...new Set(conflicts)];
}

function containsExcluded(copy: readonly string[], name: string, active: readonly string[]): boolean {
  if (activeContainsSameAlternative(active, name)) return false;
  return copy.some((item) => containsExcludedAlternativeMention(item, [name]));
}

function activeContainsSameAlternative(active: readonly string[], name: string): boolean {
  const aliases = alternativeMentionAliases(name);
  return active.some((item) => aliases.some((alias) => item.includes(alias)));
}
function record(value: unknown): Json | undefined { return value && typeof value === "object" && !Array.isArray(value) ? value as Json : undefined; }
function text(value: unknown): string { return typeof value === "string" ? value.trim() : ""; }
