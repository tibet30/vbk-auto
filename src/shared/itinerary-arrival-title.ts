import { toPlatformShortLocationName } from './location-short-name.js';

type Json = Record<string, unknown>;

/** 首日标题前缀「【出发地-城市】」；没有可用城市时为空。 */
export function arrivalTitlePrefix(product: Json): string {
  const basic = isRecord(product.basicInfo) ? product.basicInfo : {};
  const city = toPlatformShortLocationName(basic.meetingCity)
    || toPlatformShortLocationName(basic.destinationCity);
  return city ? `【出发地-${city}】` : '';
}

/** Keep the origin as a sales placeholder; the locked arrival city supplies the destination. */
export function normaliseItineraryArrivalTitle(product: Json): Json {
  const prefix = arrivalTitlePrefix(product);
  if (!prefix || !Array.isArray(product.itinerary)) return product;
  return { ...product, itinerary: product.itinerary.map(day => {
    if (!isRecord(day) || Number(day.day) !== 1 || typeof day.title !== 'string' || !day.title.trim()) return day;
    // Repeated saves and explicit city corrections must not accumulate old prefixes.
    const title = day.title.trim().replace(/^(?:【出发地\s*[-－—–]\s*[^】]+】\s*)+/u, '');
    return { ...day, title: `${prefix}${title}` };
  }) };
}

function isRecord(value: unknown): value is Json {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
