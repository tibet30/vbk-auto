import type { RouteLocationEvidence } from '../../shared/route-location-evidence.js';
import { routeLocationKey } from '../../shared/route-location-evidence.js';
import { originalOvernightRoute } from '../../shared/original-itinerary-route.js';
import { toPlatformShortLocationName } from '../../shared/location-short-name.js';
import { isProtectedRoutePoiPlaceName } from '../../shared/route-place-name.js';
import { hasCompletePoi } from '../../shared/itinerary-activity-kind.js';
import { isIndependentItineraryExperience } from '../../shared/independent-itinerary-experience.js';
import { isNonWritableCityAlias } from '../../shared/region-overrides.js';
import { requiresItineraryPoi } from '../../shared/itinerary-activity-kind.js';
import { trustedOperatorItineraryRemovals } from '../../shared/trusted-operator-itinerary-removals.js';
import { orderedItineraryRoutePath } from '../../shared/itinerary-route-path.js';

type Json = Record<string, any>;

/** Query only original route tokens. No candidate locations or generated hotel cities. */
export async function resolveRouteLocations(product: Json, query: (name: string) => Promise<Json | undefined>) {
  const locations: RouteLocationEvidence[] = [];
  const removals = trustedOperatorItineraryRemovals(product);
  for (const day of product.itinerary ?? []) {
    const sourceRoute = originalOvernightRoute(product, day);
    if (!sourceRoute) continue;
    for (const match of orderedItineraryRoutePath(sourceRoute).matchAll(/(?:^|[-—–→，,、\/／])\s*([^\-—–→，,、\/／]+)/gu)) {
      const token = match[1].trim();
      const name = administrativeQueryName(token);
      if (!name || isProtectedRoutePoiPlaceName(name) || isIndependentItineraryExperience(name) || isNonWritableCityAlias(name)) continue;
      if (removals.some(receipt => receipt.day === Number(day.day) && (receipt.name === name || receipt.poiName === name))) continue;
      // Bound attractions are not administrative anchors and cannot self-prove a route.
      if ((day.spots ?? []).some((spot: Json) => spot.name === name && (hasCompletePoi(spot) || !requiresItineraryPoi(spot)))) continue;
      const district = await query(name);
      if (!district) continue;
      const parents: Json[] = district.parents;
      const province = toPlatformShortLocationName(parents.find(parent => /^(?:province|municipality)$/iu.test(parent.districtType))?.districtName);
      const type = String(district.districtType);
      const ownName = toPlatformShortLocationName(district.districtName);
      const parentCity = toPlatformShortLocationName(parents.find(parent => /^(?:city|municipality)$/iu.test(parent.districtType))?.districtName);
      const city = parentCity || (/^(?:city|municipality)$/iu.test(type) ? ownName : '');
      if (!province || !city) continue;
      const start = (match.index ?? 0) + match[0].indexOf(match[1]);
      const position = sourceRoute.indexOf(name, start);
      if (position < 0) continue;
      locations.push({ day: Number(day.day), name, districtId: Number(district.districtId), province, city,
        ...(ownName !== city ? { district: ownName } : {}),
        position, sourceRoute, routeKey: routeLocationKey(product, day) });
    }
  }
  return locations;
}

function administrativeQueryName(token: string): string | undefined {
  const name = token.replace(/[（(【][^）)】]*[）)】]/gu, '').replace(/^[\s:：*]+|[\s。；;*]+$/gu, '')
    .replace(/^(?:抵达|到达|前往|入住|住宿于|住宿在|住在|住)/u, '')
    .replace(/(?:\d{1,2}[:：]\d{2})?(?:集合|接团|送团|接机|送机|接站|送站|送飞机|送高铁|住宿|接|送)$/u, '').trim();
  if (name.length < 2 || name.length > 20 || /\d|[&＆>＞]|自由活动|酒店|航班|漂流|娱乐|旅拍|穿越|徒步|爬犁|滑雪|雪圈|雪地|返程|入住|泡温泉|美食/u.test(name)) return undefined;
  if (/^(?:出发地|客源地|接机|送机|接站|送站|送火车|火车站|高铁站|机场)$/u.test(name)) return undefined;
  return name;
}
