import { originalOvernightRoute } from './original-itinerary-route.js';
export { originalOvernightRoute } from './original-itinerary-route.js';
import { verifiedRouteOvernightCity } from './route-location-evidence.js';
import { hasCompletePoi, requiresItineraryPoi } from './itinerary-activity-kind.js';
import { toPlatformShortLocationName } from './location-short-name.js';

type Json = Record<string, any>;
const short = (value: unknown) => toPlatformShortLocationName(value);
const compact = (value: unknown) => typeof value === 'string' ? value.replace(/\s+/gu, '') : '';

/** Infer only from original stops whose bound POIs agree on their administrative location. */
export function verifiedOvernightCity(product: Json, day: Json): string | undefined {
  const anchoredCity = verifiedRouteOvernightCity(product, day);
  if (anchoredCity) return anchoredCity;
  const source = originalOvernightRoute(product, day);
  if (!source) return undefined;
  const spots: Json[] = (day.spots ?? []).filter((spot: Json) => requiresItineraryPoi(spot));
  const bound = spots.filter(spot => hasCompletePoi(spot));
  if (!bound.length) return undefined;
  const province = short(product.basicInfo?.province);
  if (bound.some(spot => !compact(spot.name) || !compact(source).includes(compact(spot.name))
    || !short(spot.province) || (province && short(spot.province) !== province) || !short(spot.city))) return undefined;
  const provinces = new Set(bound.map(spot => short(spot.province)));
  const cities = new Set(bound.map(spot => short(spot.city)));
  if (provinces.size !== 1 || cities.size !== 1) return undefined;
  const location = bound[0]!;
  if (!originalDaySupportsLocation(product, day, location)) {
    const previous = product.itinerary?.find((item: Json) => Number(item.day) === Number(day.day) - 1);
    const following = product.itinerary?.find((item: Json) => Number(item.day) === Number(day.day) + 1);
    if (!previous || !following || !originalDaySupportsLocation(product, previous, location)
      || !originalDaySupportsLocation(product, following, location)) return undefined;
  }
  const districts = new Set(bound.map(spot => short(spot.district)));
  const district = [...districts][0];
  // A county-level overnight city can be more specific than the catalog's city
  // parent. Require an explicit original service or administrative token as proof;
  // a village, town, city district or scenic area is never promoted to a city.
  if (districts.size === 1 && district && !/(?:区|村|镇|乡|景区|园区|片区|街区)$/u.test(district)) {
    const escaped = district.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    if (new RegExp(`${escaped}(?:市|县|旗|接站|送站|接机|送机|接团|送团)`, 'u')
      .test(String(product.basicInfo?.userIdea ?? ''))) return district;
  }
  return [...cities][0];
}

function originalDaySupportsLocation(product: Json, day: Json, location: Json): boolean {
  const raw = compact(originalOvernightRoute(product, day));
  const locations = [short(location.city), short(location.district)].filter(value => value.length >= 2);
  if (!raw || !locations.some(value => raw.includes(compact(value)))) return false;
  const bound: Json[] = (day.spots ?? []).filter((spot: Json) => requiresItineraryPoi(spot) && hasCompletePoi(spot));
  return bound.length > 0 && bound.every(spot => compact(spot.name) && raw.includes(compact(spot.name))
    && short(spot.province) === short(location.province) && short(spot.city) === short(location.city)
    && (!short(location.district) || short(spot.district) === short(location.district)));
}

export function originalRouteEndsAtArrival(product: Json, day: Json): boolean {
  const source = originalOvernightRoute(product, day);
  if (!source) return false;
  const endpoint = source.replace(/[（(][^）)]*[）)]/gu, '').split(/[-—–→]+/u).at(-1)?.trim()
    .replace(/^(?:入住|住宿于|住在|住)\s*/u, '').replace(/[。；;，,]+$/u, '');
  return Boolean(endpoint) && short(endpoint) === short(product.basicInfo?.meetingCity || product.basicInfo?.destinationCity);
}
