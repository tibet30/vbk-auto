import { requiresItineraryPoi } from "./itinerary-activity-kind.js";

type Image = { poiId?: number; poiName?: string; poi?: string };
type Poi = { poiId?: number; name: string };
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** 已确认免费景点不强制；缺少门票类型时先按所有行程景点准备，避免漏图。 */
export function requiredTourImagePois(product: Record<string, unknown>): Poi[] {
  const days = Array.isArray(product.itinerary) ? product.itinerary : [];
  const result: Poi[] = [];
  for (const day of days) {
    const spots = record(day).spots;
    for (const item of Array.isArray(spots) ? spots : []) {
      const spot = record(item);
      if (!requiresItineraryPoi(spot) || Number(record(spot.ticketType).key) === 2) continue;
      const name = String(spot.poiName || spot.name || "").trim();
      const poiId = Number(spot.poiId) || undefined;
      if (name && !result.some(poi => poiId ? poi.poiId === poiId : poi.name === name)) result.push({ name, poiId });
    }
  }
  return result;
}

export function missingTourImagePois(product: Record<string, unknown>, images: Image[]): Poi[] {
  return requiredTourImagePois(product).filter(poi => !images.some(image =>
    poi.poiId && image.poiId ? poi.poiId === image.poiId : poi.name === (image.poiName || image.poi)));
}
