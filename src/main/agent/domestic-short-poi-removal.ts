import type { ProductDetail } from "../../shared/contracts.js";
import { domesticShortPoiRiskQuestionName } from "../../shared/domestic-short-poi-risk.js";
import { applyItinerarySpotRemove } from "../operations/manual-review-itinerary-field.js";
import {
  bindTrustedOperatorItineraryRemovalIdentity,
  trustedOperatorItineraryRemovals,
} from "../../shared/trusted-operator-itinerary-removals.js";

type SelectedQuestion = { id: string; label: string; selectedLabel: string };
type Json = Record<string, unknown>;

function record(value: unknown): Json | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Json : undefined;
}

function matchesRiskPoi(spot: Json, poiName: string): boolean {
  return [spot.name, spot.poiName].some((value) => typeof value === "string" && value.includes(poiName));
}

export function removeConfirmedDomesticShortPoiRisk(
  detail: ProductDetail,
  questions: readonly SelectedQuestion[],
): { product: Json; poiName: string; removed: number } | undefined {
  const selected = questions.find((item) => {
    const poiName = domesticShortPoiRiskQuestionName(item.id);
    return poiName && item.selectedLabel === `确认剔除「${poiName}」并重新核对方案`;
  });
  const poiName = selected && domesticShortPoiRiskQuestionName(selected.id);
  if (!poiName) return undefined;

  let product = structuredClone(detail.product) as Json;
  const itinerary = Array.isArray(product.itinerary) ? product.itinerary : [];
  const matchingSpots = itinerary.flatMap((value) => {
    const day = record(value); const spots = Array.isArray(day?.spots) ? day.spots : [];
    return spots.map(record).filter((spot): spot is Json => spot !== undefined && matchesRiskPoi(spot, poiName));
  });
  const identified = matchingSpots.find((spot) => Number.isInteger(Number(spot.poiId)) && Number(spot.poiId) > 0)
    ?? matchingSpots.find((spot) => typeof spot.poiName === "string");
  const identity = identified ? {
    poiName: typeof identified.poiName === "string" ? identified.poiName : poiName,
    poiId: Number.isInteger(Number(identified.poiId)) && Number(identified.poiId) > 0 ? Number(identified.poiId) : undefined,
  } : undefined;
  let removed = 0;
  for (let dayIndex = itinerary.length - 1; dayIndex >= 0; dayIndex -= 1) {
    const day = record((product.itinerary as unknown[])[dayIndex]);
    const spots = Array.isArray(day?.spots) ? day.spots : [];
    for (let spotIndex = spots.length - 1; spotIndex >= 0; spotIndex -= 1) {
      const spot = record(spots[spotIndex]);
      if (!spot || !matchesRiskPoi(spot, poiName)) continue;
      product = applyItinerarySpotRemove(product, { field: "itinerarySpotRemove", dayIndex, spotIndex });
      removed += 1;
    }
  }
  if (identity) {
    for (const receipt of trustedOperatorItineraryRemovals(product)) {
      if (!receipt.name.includes(poiName) && receipt.poiName !== poiName) continue;
      bindTrustedOperatorItineraryRemovalIdentity(product, receipt.day, receipt.name, identity);
    }
  }
  return { product, poiName, removed };
}
