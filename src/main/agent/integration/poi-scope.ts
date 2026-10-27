import type { ProductDetail, PoiSuggestDetailResult } from '../../../shared/contracts.js';
import { requiresItineraryPoi } from '../../../shared/itinerary-activity-kind.js';
import { buildPoiContextForItineraryDay } from '../../planning/poi-context.js';
import { isPlanningPoiCandidateInContext } from '../../planning/poi-auto-selection.js';
import { cleanText, positiveInteger, productData, selectItinerarySpot, type JsonObject } from './util.js';

/** Search and selection must resolve the same original slot and geographic scope. */
export function itineraryPoiScope(current: ProductDetail, day: number, spotName: string) {
  const slot = selectItinerarySpot(current, day, spotName);
  if (!requiresItineraryPoi(slot.spot)) throw new Error('自由活动或其他活动无需配置 POI；请先切换为景点。');
  const product = productData(current);
  const basic = product.basicInfo as JsonObject | undefined;
  const context = { ...buildPoiContextForItineraryDay(product, cleanText(basic?.destinationCity || basic?.meetingCity),
    Array.isArray(product.itinerary) ? product.itinerary[slot.dayIndex] : undefined, cleanText(slot.spot.name)),
    itineraryDay: day, spotName: cleanText(slot.spot.name) };
  return { ...slot, day, spotName: cleanText(slot.spot.name), context, product };
}

export function findPoiQueryScope(current: ProductDetail, keyword: string, args: JsonObject) {
  const name = cleanText(args.spotName) || keyword;
  if (args.day !== undefined) return itineraryPoiScope(current, positiveInteger(args.day, 'day'), name);
  const itinerary = Array.isArray(current.product.itinerary) ? current.product.itinerary as JsonObject[] : [];
  const slots = itinerary.flatMap(day => (Array.isArray(day.spots) ? day.spots as JsonObject[] : [])
    .filter(spot => requiresItineraryPoi(spot) && (spot.name === name || spot.poiName === name))
    .map(() => ({ day: Number(day.day), name })));
  return slots.length === 1 ? itineraryPoiScope(current, slots[0]!.day, name) : undefined;
}

export function screenPoiQueryForScope(detail: PoiSuggestDetailResult, scope: ReturnType<typeof findPoiQueryScope>): PoiSuggestDetailResult {
  const candidates = detail.candidates.map(candidate => ({ ...candidate, selectable: candidate.selectable && Boolean(scope
    && isPlanningPoiCandidateInContext(candidate, scope.context, scope.product, scope.spotName, detail.candidates)) }));
  return { ...detail, candidates, best: candidates.some(candidate => candidate.selectable && candidate.poiId === detail.best?.poiId)
    ? detail.best : null };
}
