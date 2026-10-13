import { validPlatformHotelRules } from "../../../shared/platform-hotel-rules.js";

type Json = Record<string, any>;
/** The platform reads back an empty geographic filter as its single 不限 option. */
function unrestrictedFilter(value: unknown): boolean {
  return value == null || Array.isArray(value) && (value.length === 0 || value.length === 1
    && String(value[0]?.key) === "0" && value[0]?.value === "不限");
}
/** Platform product-input 15-e2a3dd: generateSaveSegmentData removes isIncludeSystem;
 * persisted systemHotel presence represents the enabled automatic matching switch. */
export function buildPlatformHotelRule(segment: Json, rules: unknown) {
  if (!validPlatformHotelRules(rules)) throw new Error("平台酒店规则必须自动匹配三钻、四钻、五钻");
  const city = segment.segmentBase?.destinationCity;
  if (!Number.isSafeInteger(Number(city?.cityId)) || Number(city.cityId) <= 0) throw new Error("酒店规则缺少合法住宿城市 ID");
  return { segmentRooms: [], segmentRoomBlackList: [], systemHotel: {
    hotelStar: [...rules.grades], geoLocation: { globalId: String(city.cityId), name: city.cityName, categoryId: 3 },
    zones: [], locations: [], ranking: [], goodHotel: "F",
  } };
}
export function platformHotelRuleMatches(segment: Json, rules: unknown): boolean {
  const hotel = segment.hotel;
  const system = hotel?.systemHotel;
  const city = segment.segmentBase?.destinationCity;
  return validPlatformHotelRules(rules) && validPlatformHotelRules({ autoMatch: Boolean(system), grades: system?.hotelStar })
    && Number.isSafeInteger(Number(city?.cityId)) && Number(city?.cityId) > 0
    && Number(system?.geoLocation?.globalId) === Number(city?.cityId)
    && Number(system?.geoLocation?.categoryId) === 3
    && (!system?.geoLocation?.name || system.geoLocation.name === city?.cityName)
    && (system?.goodHotel == null || system.goodHotel === "F")
    && (hotel?.segmentRooms == null || Array.isArray(hotel.segmentRooms) && hotel.segmentRooms.length === 0)
    && (hotel.segmentRoomBlackList == null || Array.isArray(hotel.segmentRoomBlackList) && hotel.segmentRoomBlackList.length === 0)
    && ["zones", "locations"].every(key => unrestrictedFilter(system?.[key]))
    && (system?.ranking == null || Array.isArray(system.ranking) && system.ranking.length === 0);
}
export function platformHotelRuleProjection(segment: Json) {
  const rule = segment.hotel?.systemHotel;
  return rule ? { grades: [...(rule.hotelStar ?? [])].map(Number).sort(), cityId: String(rule.geoLocation?.globalId),
    categoryId: Number(rule.geoLocation?.categoryId), goodHotel: rule.goodHotel ?? "F",
    zones: unrestrictedFilter(rule.zones) ? [] : rule.zones,
    locations: unrestrictedFilter(rule.locations) ? [] : rule.locations, ranking: rule.ranking ?? [],
    excludedHotels: segment.hotel?.segmentRoomBlackList ?? [] } : null;
}
export function platformHotelRuleFailureDetail(segment: Json) {
  const hotel = segment.hotel;
  const system = hotel?.systemHotel;
  return { segmentId: String(segment.segmentId), autoMatch: Boolean(system), grades: system?.hotelStar,
    city: { expected: segment.segmentBase?.destinationCity, actual: system?.geoLocation },
    goodHotel: system?.goodHotel, specifiedHotels: hotel?.segmentRooms ?? null,
    excludedHotels: hotel?.segmentRoomBlackList ?? null,
    filters: { zones: system?.zones, locations: system?.locations, ranking: system?.ranking } };
}
