import type { ProductDetail } from '../../shared/contracts.js';
import { hasCompletePoi, requiresItineraryPoi } from '../../shared/itinerary-activity-kind.js';
import { toPlatformShortLocationName } from '../../shared/location-short-name.js';
import { hasCompleteNumberedRoute } from './numbered-route-constraints.js';
import { extractLockedConstraints } from '../agent/prompt-helpers.js';
import { classifyItineraryInputMode } from './itinerary-input-contract.js';
import { vbkSessionRequest, type VbkSessionRequestBrowser } from '../infrastructure/vbk-session-request.js';
import { retryVbkRead } from '../infrastructure/vbk-read-retry.js';
import { assertVbkAckSuccess } from '../infrastructure/vbk-response-error.js';
import { buildSuggestDistrictRequest, SUGGEST_DISTRICT_ENDPOINT } from '../infrastructure/suggest-district.js';

type Json = Record<string, any>;
/** 完整原始逐日路线中，将平台唯一确认的行政节点移回交通安排。 */
export async function normaliseNumberedRouteAdministrativeNodes(detail: ProductDetail, page: VbkSessionRequestBrowser) {
  const basic = detail.product.basicInfo as Json;
  const raw = String(basic?.userIdea ?? '');
  const numbered = hasCompleteNumberedRoute(raw, Number(basic?.days));
  const locked = extractLockedConstraints(detail, detail.messages ?? []);
  const complete = classifyItineraryInputMode(locked, Number(basic?.days), detail.planning?.userIntent) === 'complete';
  if (detail.productId || (!numbered && !complete) || !basic.province) return undefined;
  const itinerary = structuredClone(detail.product.itinerary) as Json[];
  const converted: Array<{ day: number; name: string; districtId: number }> = [];
  const districts = new Map<string, Json | undefined>();
  for (const day of itinerary) {
    const line = raw.split(/[\n\r]/).find(line => new RegExp(`^\\s*${day.day}\\s*[-、:：.]`).test(line));
    const route = numbered ? line?.replace(/^\s*\d+\s*[-、:：.]\s*/, '').split(/[-—–→]+/u).map(name => name.replace(/[;；。]+$/u, '').trim()) ?? []
      : locked.itineraryOrder.find(row => row.day === Number(day.day))?.spots ?? [];
    const kept = [];
    for (const spot of day.spots ?? []) {
      const name = String(spot.name ?? '').trim();
      if (!requiresItineraryPoi(spot) || hasCompletePoi(spot) || !route.includes(name)) { kept.push(spot); continue; }
      if (!districts.has(name)) {
        const response = await retryVbkRead(() => vbkSessionRequest(page, {
          endpoint: SUGGEST_DISTRICT_ENDPOINT, body: buildSuggestDistrictRequest(toPlatformShortLocationName(name)),
          errorLabel: '逐日路线行政节点核验', includeCidQuery: false, browserRequestTimeoutMs: 12000, evaluateTimeoutMs: 15000,
        }));
        const payload = assertVbkAckSuccess(response.payload, '逐日路线行政节点核验') as Json;
        districts.set(name, exactRouteAdministrativeDistrict(payload, name, numbered ? String(basic.province) : undefined));
      }
      const district = districts.get(name);
      if (!district) { kept.push(spot); continue; }
      converted.push({ day: Number(day.day), name, districtId: Number(district.districtId) });
      const activities: Json[] = day.activities ?? [];
      if (!activities.some(item => `${item.title ?? ''} ${item.detail ?? ''}`.includes(name))) {
        activities.push({ time: '不限', type: 'transport', title: `${name}行政地点与交通衔接`, detail: day.description || `按原始路线经${name}，保留当地停留安排。` });
      }
      day.activities = activities;
    }
    day.spots = kept;
  }
  return converted.length ? { itinerary, converted } : undefined;
}

export function exactRouteAdministrativeDistrict(payload: Json, name: string, province?: string): Json | undefined {
  const matches = (Array.isArray(payload.districts) ? payload.districts : []).filter((item: Json) =>
    Number(item.districtId) > 0 && toPlatformShortLocationName(item.districtName) === toPlatformShortLocationName(name)
    && /^(?:city|district|county|municipality)$/i.test(String(item.districtType))
    && Array.isArray(item.parents) && item.parents.some((parent: Json) => /^(?:province|municipality)$/i.test(String(parent.districtType))
      && (!province || toPlatformShortLocationName(parent.districtName) === toPlatformShortLocationName(province))));
  return matches.length === 1 ? matches[0] : undefined;
}
