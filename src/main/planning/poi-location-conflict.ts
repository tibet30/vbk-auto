import type { PoiSuggestCandidate } from '../../shared/contracts-types.js';
import { toPlatformShortLocationName as short } from '../../shared/location-short-name.js';
import { routeLocationsForKeyword } from '../../shared/route-location-evidence.js';
import { hasOriginalPoiNameEvidence } from '../../shared/poi-original-route-identity.js';
import { isPlanningPoiCandidateInContext } from './poi-auto-selection.js';
import type { PoiSuggestContext } from './types.js';
import { inferExplicitPoiDayCity } from './poi-context.js';

/** Rejection of a new selection is not proof that a saved identity is wrong. */
export function hasDefinitePoiLocationConflict(candidate: PoiSuggestCandidate, context: PoiSuggestContext,
  product: Record<string, unknown>, keyword: string): boolean {
  const locations = routeLocationsForKeyword(product, context.spotName || keyword, context.itineraryDay);
  if (locations.length && locations.some(location =>
    (!short(candidate.province) || short(candidate.province) === location.province)
    && (!short(candidate.city) || short(candidate.city) === location.city)
    && (!short(candidate.district) || !location.district || short(candidate.district) === location.district))) return false;
  if (isPlanningPoiCandidateInContext(candidate, context, product, keyword, [candidate])) return false;
  if (short(candidate.province) && short(context.province) && short(candidate.province) !== short(context.province)) return true;
  // 路线锚点只到城市级。羊卓雍措（山南）夹在拉萨—日喀则之间、冈仁波齐
  // （阿里）在萨嘎之后，原路线点名了它们，但相邻锚点永远不会写出山南/阿里。
  // 只有「当天确有同省锚点」时，原文点名+平台身份才算当前证据；没有锚点
  // 的旧产品仍按明确的当日城市判定，避免把汕头日的中山炮台公园当成同省放行。
  const anchorsSameProvince = locations.length > 0 && Boolean(short(candidate.province))
    && locations.every(location => short(location.province) === short(candidate.province));
  if (anchorsSameProvince && hasCurrentOriginalNameEvidence(product, context, keyword, candidate)) return false;
  if (locations.some(location => location.bounded)) return true;
  return Boolean(short(candidate.city) && short(context.destinationCity)
    && short(candidate.city) !== short(context.destinationCity));
}

function hasCurrentOriginalNameEvidence(product: Record<string, unknown>, context: PoiSuggestContext,
  keyword: string, candidate: PoiSuggestCandidate): boolean {
  if (!Array.isArray(product.itinerary)) return false;
  const days = product.itinerary.filter(isRecord);
  const target = context.spotName || keyword;
  const day = days.find((value) => Number(value.day) === Number(context.itineraryDay))
    // 少数上下文（同日本地路线一致）不带 itineraryDay，用当前景点名反查当天；
    // 原文仍必须点名该景点，证据强度不变。
    ?? days.find((value) => (Array.isArray(value.spots) ? value.spots : []).some((spot) =>
      isRecord(spot) && spot.name === target));
  if (!isRecord(day)) return false;
  // 当天文案明确写出另一个城市时（例如「汕头公园游览」），原路线点名不足以
  // 把同省错城绑定洗白；只有文案没有明确城市时，才用「同省 + 原文点名」兜底。
  const explicitDayCity = inferExplicitPoiDayCity(day);
  if (explicitDayCity && short(candidate.city) && short(explicitDayCity) !== short(candidate.city)) return false;
  return hasOriginalPoiNameEvidence(product, day, target, candidate.poiName ?? '');
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
