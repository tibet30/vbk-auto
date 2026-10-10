import { requiresItineraryPoi } from "./itinerary-activity-kind.js";
import { dayHasTransportArrangement, supportArrangementType } from "./itinerary-support-arrangements.js";

/** A day can contain only non-attractions when its ordered spots say so.
 * Legacy activities remain readable, but are never required to be user-only. */
export function dayHasUserOtherActivity(day: unknown): boolean {
  if (!day || typeof day !== "object" || Array.isArray(day)) return false;
  const record = day as Record<string, unknown>;
  if (dayHasTransportArrangement(day)) return true;
  const spots = Array.isArray(record.spots) ? record.spots.filter((spot) => !supportArrangementType(spot, record)) : record.spots;
  if (Array.isArray(spots) && spots.length > 0 && spots.every((spot) => spot && typeof spot === "object" && !Array.isArray(spot) && !requiresItineraryPoi(spot as Record<string, unknown>))) return true;
  const activities = record.activities;
  if (!Array.isArray(activities)) return false;
  return activities.some((activity) => {
    if (!activity || typeof activity !== "object" || Array.isArray(activity)) return false;
    const row = activity as Record<string, unknown>;
    return (row.type === "other" || row.type === "free")
      && !supportArrangementType(row, record)
      && hasText(row.time)
      && hasText(row.title)
      && hasText(row.detail);
  });
}

function hasText(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}
