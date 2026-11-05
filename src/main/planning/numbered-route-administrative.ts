import { resolveRouteLocations } from './route-location-resolution.js';
import { withRouteRequirements } from '../../shared/route-requirement-context.js';
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
import { isProtectedRoutePoiPlaceName } from '../../shared/route-place-name.js';
import { constraintUserIdea } from '../../shared/product-idea-optimization.js';

type Json = Record<string, any>;

/** 完整原始逐日路线中，将平台唯一确认的行政节点移回交通安排。 */
export async function normaliseNumberedRouteAdministrativeNodes(detail: ProductDetail, page: VbkSessionRequestBrowser) {
  const basic = detail.product.basicInfo as Json;
  const raw = constraintUserIdea(basic);
  const numbered = hasCompleteNumberedRoute(raw, Number(basic?.days));
  const locked = extractLockedConstraints(detail, detail.messages ?? []);
  const complete = classifyItineraryInputMode(locked, Number(basic?.days), detail.planning?.userIntent) === 'complete';
  if ((!numbered && !complete) || !basic.province) return undefined;
  const itinerary = structuredClone(detail.product.itinerary) as Json[];
  const converted: Array<{ day: number; name: string; districtId: number }> = [];
  const payloads = new Map<string, Json>();
  const queryPayload = async (name: string) => {
    if (!payloads.has(name)) {
      const response = await retryVbkRead(() => vbkSessionRequest(page, {
        endpoint: SUGGEST_DISTRICT_ENDPOINT, body: buildSuggestDistrictRequest(toPlatformShortLocationName(name)),
        errorLabel: '逐日路线行政节点核验', includeCidQuery: false, browserRequestTimeoutMs: 12000, evaluateTimeoutMs: 15000,
      }));
      payloads.set(name, assertVbkAckSuccess(response.payload, '逐日路线行政节点核验') as Json);
    }
    return payloads.get(name)!;
  };
  // 景点转交通只认县级以上；周庄、乌镇这类镇名景点不能被转走。
  const queryDistrict = async (name: string) => exactRouteAdministrativeDistrict(await queryPayload(name), name);
  // 路线锚点可用唯一乡镇（川主寺镇），它只证明当天经过的县与州。
  const queryAnchor = async (name: string) => exactRouteAdministrativeDistrict(await queryPayload(name), name, undefined, { allowTown: true });
  for (const day of itinerary) {
    const line = raw.split(/[\n\r]/).find(line => new RegExp(`^\\s*${day.day}\\s*[-、:：.]`).test(line));
    const route = locked.itineraryOrder.find(row => row.day === Number(day.day))?.spots
      ?? (numbered ? line?.replace(/^\s*\d+\s*[-、:：.]\s*/, '').split(/[-—–→]+/u).map(name => name.replace(/[;；。]+$/u, '').trim()) ?? [] : []);
    const kept = [];
    for (const spot of day.spots ?? []) {
      const name = String(spot.name ?? '').trim();
      if (!requiresItineraryPoi(spot) || hasCompletePoi(spot) || !route.includes(name) || isProtectedRoutePoiPlaceName(name)) {
        kept.push(spot); continue;
      }
      const district = await queryDistrict(name);
      if (!district) { kept.push(spot); continue; }
      converted.push({ day: Number(day.day), name, districtId: Number(district.districtId) });
      const activities: Json[] = day.activities ?? [];
      const generated = activities.find(item => /行政地点与交通衔接$/u.test(String(item.title ?? '')));
      if (generated && !String(generated.title).includes(name)) {
        const names = String(generated.title).replace(/行政地点与交通衔接$/u, '').split('、').filter(Boolean);
        generated.title = `${[...new Set([...names, name])].join('、')}行政地点与交通衔接`;
      } else if (!activities.some(item => `${item.title ?? ''} ${item.detail ?? ''}`.includes(name))) {
        activities.push({ time: '不限', type: 'transport', title: `${name}行政地点与交通衔接`, detail: day.description || `按原始路线经${name}，保留当地停留安排。` });
      }
      day.activities = activities;
    }
    day.spots = kept;
  }
  const sourceProduct = withRouteRequirements(detail.product, detail.messages ?? []);
  const locations = await resolveRouteLocations({ ...sourceProduct, itinerary }, queryAnchor);
  const previousLocations = (detail.product.diagnostics as Json | undefined)?.routeLocations;
  return converted.length || locations.length || previousLocations?.length ? { itinerary, converted, locations } : undefined;
}

export function exactRouteAdministrativeDistrict(payload: Json, name: string, province?: string,
  options: { allowTown?: boolean } = {}): Json | undefined {
  const districts: Json[] = Array.isArray(payload.districts) ? payload.districts : [];
  const inProvince = (item: Json) => Number(item.districtId) > 0
    && Array.isArray(item.parents) && item.parents.some((parent: Json) => /^(?:province|municipality)$/i.test(String(parent.districtType))
      && (!province || toPlatformShortLocationName(parent.districtName) === toPlatformShortLocationName(province)));
  const matches = districts.filter(item => inProvince(item)
    && toPlatformShortLocationName(item.districtName) === toPlatformShortLocationName(name)
    && /^(?:city|district|county|municipality)$/i.test(String(item.districtType)));
  if (matches.length || !options.allowTown) return matches.length === 1 ? matches[0] : undefined;
  const plain = name.trim().replace(/(?:镇|乡)$/u, '');
  const towns = districts.filter(item => inProvince(item) && /^(?:town|township)$/i.test(String(item.districtType))
    && String(item.districtName ?? '').trim().replace(/(?:镇|乡)$/u, '') === plain);
  return plain.length >= 2 && towns.length === 1 ? towns[0] : undefined;
}
