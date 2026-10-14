import type { ManualReviewFieldInput, PoiSuggestDetailResult } from "../../shared/contracts.js";
import { isPlanningPoiCandidateInContext } from "../planning/poi-auto-selection.js";

type Json = Record<string, unknown>;
type PoiInput = Extract<ManualReviewFieldInput, { field: "itinerarySpotPoi" }>;

function record(value: unknown): Json {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Json : {};
}

function selectionContext(product: Json, dayIndex: number, spotIndex: number) {
  if (!Number.isInteger(dayIndex) || dayIndex < 0 || !Number.isInteger(spotIndex) || spotIndex < 0) {
    throw new Error("行程 POI 目标索引不合法。");
  }
  const itinerary = Array.isArray(product.itinerary) ? product.itinerary : [];
  const day = record(itinerary[dayIndex]);
  const spots = Array.isArray(day.spots) ? day.spots : [];
  const spot = record(spots[spotIndex]);
  const spotName = typeof spot.name === "string" ? spot.name.trim() : "";
  if (!spotName) throw new Error("目标行程景点不存在或缺少原始名称。");
  const basic = record(product.basicInfo);
  return {
    spotName,
    context: {
      destinationCity: typeof basic.destinationCity === "string" ? basic.destinationCity.trim() : undefined,
      province: typeof basic.province === "string" ? basic.province.trim() : undefined,
    },
  };
}

/** Keeps every provider row visible, but only same-route candidates selectable. */
export function screenManualPoiCandidates(
  product: Json,
  dayIndex: number,
  spotIndex: number,
  detail: PoiSuggestDetailResult,
): PoiSuggestDetailResult {
  const { spotName, context } = selectionContext(product, dayIndex, spotIndex);
  const selectableIds = new Set(detail.candidates.filter((candidate): candidate is typeof candidate & { poiId: number } =>
    candidate.poiId !== null
      && isPlanningPoiCandidateInContext(candidate, context, product, spotName, detail.candidates))
    .map(candidate => candidate.poiId));
  const candidates = detail.candidates.map(candidate => ({
    ...candidate,
    selectable: candidate.poiId !== null && candidate.selectable && selectableIds.has(candidate.poiId),
  }));
  const best = detail.best && detail.best.poiId !== null && selectableIds.has(detail.best.poiId)
    ? detail.best
    : null;
  return { ...detail, best, candidates };
}

/** Rebuilds the write payload from the current provider response, never renderer location fields. */
export function verifyManualPoiSelection(
  product: Json,
  input: PoiInput,
  detail: PoiSuggestDetailResult,
): PoiInput {
  const screened = screenManualPoiCandidates(product, input.dayIndex, input.spotIndex, detail);
  const candidate = screened.candidates.find(item => item.poiId === input.poiId && item.selectable && item.poiName?.trim());
  if (!candidate?.poiName || !candidate.poiId) {
    const { spotName } = selectionContext(product, input.dayIndex, input.spotIndex);
    throw new Error(`POI「${input.poiName.trim()}」与原行程景点「${spotName}」的地域约束不匹配，不能保存。`);
  }
  return {
    field: "itinerarySpotPoi",
    dayIndex: input.dayIndex,
    spotIndex: input.spotIndex,
    poiName: candidate.poiName.trim(),
    poiId: candidate.poiId,
    province: candidate.province?.trim() || null,
    city: candidate.city?.trim() || null,
    district: candidate.district?.trim() || null,
  };
}
