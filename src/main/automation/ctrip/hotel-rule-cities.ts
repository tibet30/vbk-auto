import { originalOvernightRoute } from '../../../shared/original-itinerary-route.js';
import { toPlatformShortLocationName } from '../../../shared/location-short-name.js';
import { platformHotelStayGroups } from '../../../shared/platform-hotel-rules.js';
import { resolveResourceSegmentCityApi, segmentsFromPayload } from './vehicle-resource-api.js';
import { toVbkCityName } from '../../../shared/region-overrides.js';

type Json = Record<string, any>;

/** A saved lodging city is not proof that it shares the arrival province.
 * For explicitly named route cities, require a fresh unique Chinese city result
 * before any layout write. Never infer province from unrelated sightseeing POIs. */
export async function resolveHotelRuleRouteCities(page: any, product: Json): Promise<Map<string, Json>> {
  const cities = new Map<string, Json>();
  const anchor = toPlatformShortLocationName(product.basicInfo?.meetingCity || product.basicInfo?.destinationCity);
  for (const group of platformHotelStayGroups(product)) {
    if (cities.has(group.cityName) || group.cityName === anchor) continue;
    const days = product.itinerary.filter((day: Json) => group.dayNumbers.includes(Number(day.day)));
    if (!days.length || !days.every((day: Json) => explicitRouteCity(product, day, group.cityName))) continue;
    const city = await resolveResourceSegmentCityApi(page, group.cityName, { countryName: '中国' });
    if (!toPlatformShortLocationName(city.provinceName)) throw new Error(`住宿城市「${group.cityName}」的平台查询缺少省份，不能确认跨省住宿`);
    cities.set(group.cityName, city);
  }
  return cities;
}

/**
 * 已保存住宿段与住宿地原名对不上时（川主寺 → 松潘），重新查询该住宿地的 VBK 城市，
 * 供回读按 cityId 比对。名字已一致的住宿夜不查询，保持重复执行零请求。
 */
export async function resolveStayCityAliases(page: any, product: Json, payload: Json, cities: Map<string, Json>, formalOnly = false) {
  const lodging = segmentsFromPayload(payload, { formalOnly }).slice(1).filter((s: Json) => Number(s.segmentBase?.stayNights) > 0);
  for (const [index, group] of platformHotelStayGroups(product).entries()) {
    const saved = toPlatformShortLocationName(lodging[index]?.segmentBase?.destinationCity?.cityName);
    if (cities.has(group.cityName) || !saved || saved === toPlatformShortLocationName(toVbkCityName(group.cityName))) continue;
    cities.set(group.cityName, await resolveResourceSegmentCityApi(page, group.cityName, { countryName: '中国' }));
  }
  return cities;
}

function explicitRouteCity(product: Json, day: Json, city: string): boolean {
  const source = originalOvernightRoute(product, day);
  if (!source) return false;
  return source.split(/[-—–→>＞，,；;\/／\n]+/u).some(token => {
    const name = token.trim().replace(/^[*：:、\s]+|[*。\s]+$/gu, '')
      .replace(/^(?:抵达|到达|前往|入住|住宿于|住宿在|住在|住)/u, '')
      .replace(/(?:集合|接团|送团|接机|送机|接站|送站|住宿|接|送)$/u, '');
    return toPlatformShortLocationName(name) === city;
  });
}
