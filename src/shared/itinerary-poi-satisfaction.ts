import { hasCompletePoi, requiresItineraryPoi } from "./itinerary-activity-kind.js";

type Json = Record<string, unknown>;

/** Every explicit attraction, including each `or` sibling, needs its own real POI. */
export function alternativePoiGroupSatisfied(spots: readonly unknown[], index: number): boolean {
  const current = record(spots[index]);
  return Boolean(current && current.relation === "or" && hasCompletePoi(current));
}

/** Completion semantics used by manual POI reconciliation. */
export function itineraryPoiSatisfaction(itinerary: readonly unknown[]): { hasRequiredPoi: boolean; satisfied: boolean } {
  let hasRequiredPoi = false;
  for (const rawDay of itinerary) {
    const day = record(rawDay); const spots = Array.isArray(day?.spots) ? day.spots : [];
    for (let index = 0; index < spots.length; index += 1) {
      const spot = record(spots[index]);
      if (!spot || !requiresItineraryPoi(spot)) continue;
      hasRequiredPoi = true;
      if (!hasCompletePoi(spot)) return { hasRequiredPoi, satisfied: false };
    }
  }
  return { hasRequiredPoi, satisfied: true };
}

function record(value: unknown): Json | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Json : undefined;
}
