import { nightlyHotelAlternatives } from "../ctrip-hotel-locality.js";
import { hasItineraryHotelStay } from "../../../shared/itinerary-hotel.js";
export { needsItineraryHotelCandidates as shouldResolveItineraryHotelForDay } from "../../../shared/itinerary-hotel.js";
import { toPlatformShortLocationName } from "../../../shared/location-short-name.js";
import { itineraryAttractions } from "../../../shared/itinerary-activity-kind.js";
import { toWritableAdministrativeCityName, hotelLocationFromHotelText } from "../../../shared/region-overrides.js";
import { record, text, escapeRegExp } from "./helpers.js";

/** A named property must not be replaced by an arbitrary nearby hotel. */
export function explicitHotelName(day: Record<string, unknown>, city?: string): string | undefined {
  // Lodging prose is generated into this field alongside the property name.
  // Remove only explicit stay instructions; retain city and branch qualifiers.
  const hotel = text(day.hotel)
    .replace(/^(?:入住|下榻|住宿于|住宿在)\s*/u, "")
    .replace(/[，,；;\s]*(?:住宿|入住|住)(?:一|两|二|三|四|五|六|七|八|九|十|\d+)晚[。.]?$/u, "")
    .trim();
  if (!/(?:酒店|宾馆|客栈)/u.test(hotel) || /当地|区域|待核验|待匹配|[1-5一二三四五]钻|无住宿|无需|或|内(?:度假|特色)|附近|周边/u.test(hotel)) return undefined;
  const stem = hotel.replace(/[（(].*$/u, "").replace(/(?:酒店|宾馆|客栈).*$/u, "").trim();
  if (stem.length < 2 || stem === toPlatformShortLocationName(city) || /市区|城区|真实|测试/u.test(stem)) return undefined;
  return hotel;
}

/**
 * 行程录入页的酒店节点使用携程平台酒店。AI 有时只写了产品 nights，
 * 但每日 hotel 仍为空；这时按默认行程语义把前 N 天视为住宿日，
 * 让酒店候选解析补齐携程酒店。明确写“无 / 不住宿”的日子仍然跳过。
 */

/** An explicit product hotel tier is a constraint, not a ranking hint. */
/** 明确“住/入住某城”时，以落脚城市而不是当天最后景点作为酒店检索锚点。 */
export function hotelAnchorNameForDay(day: Record<string, unknown>, preferredCity?: string): string {
  const city = toPlatformShortLocationName(text(preferredCity));
  if (!city) return "";
  // `hotel` is a direct per-day lodging field.  A city mentioned in a route
  // narrative is not: “从潮州出发，入住南澳岛酒店” must never make 潮州 the
  // lodging query city merely because the sentence also contains “入住”.
  const hotelFields = [day.hotel, day.hotelDescription].map(text);
  if (hotelFields.some((value) => value.includes(city) && /(?:住|入住|住宿|酒店)/.test(value))) return city;
  const cityPattern = escapeRegExp(city);
  const lodgingInCity = new RegExp(`(?:入住|住(?:在|进)?|住宿(?:于|在)?|下榻(?:于)?)\\s*(?:当地|市区)?${cityPattern}`);
  return [day.title, day.description].map(text).some((value) => lodgingInCity.test(value)) ? city : "";
}

/** 先用同城末景点定位距离；异地末景点则直接按明确的住宿城市检索。 */
export function hotelSearchContextCityForDay(day: Record<string, unknown>, preferredCity?: string): string {
  const explicit = hotelLocationFromHotelText(text(day.hotel))
    || hotelLocationFromHotelText(text(day.hotelDescription))
    || hotelAnchorNameForDay(day, preferredCity);
  const rawSpots = Array.isArray(day.spots)
    ? day.spots.map(record).filter((spot): spot is Record<string, unknown> => Boolean(spot)) : [];
  const spots = itineraryAttractions(rawSpots) as Array<Record<string, unknown>>;
  const city = explicit || text(spots.at(-1)?.city) || text(preferredCity);
  return toPlatformShortLocationName(toWritableAdministrativeCityName(city));
}

export function hotelSearchAnchorNames(day: Record<string, unknown>, preferredCity?: string): string[] {
  const alternatives = nightlyHotelAlternatives(text(day.hotel));
  if (alternatives.length) return alternatives;
  const rawSpots = Array.isArray(day.spots) ? day.spots.map(record).filter((spot): spot is Record<string, unknown> => Boolean(spot)) : [];
  const spots = itineraryAttractions(rawSpots) as Array<Record<string, unknown>>;
  const last = spots.at(-1);
  const spotName = text(last?.poiName) || text(last?.name);
  const spotCity = toPlatformShortLocationName(text(last?.city));
  const lodgingCity = hotelSearchContextCityForDay(day, preferredCity);
  const lodgingLocation = hotelLocationFromHotelText(text(day.hotel));
  if (lodgingLocation && lodgingCity !== toPlatformShortLocationName(toWritableAdministrativeCityName(text(preferredCity)))) {
    // 异地住宿优先查询住宿字段的地标，普通活动也可提供已明确的落脚点。
    const lodgingAnchor = text(day.hotel).split(/内|附近|周边|当地|[1-5一二三四五]钻|度假酒店|特色客栈|酒店|客栈|民宿|[（(]/u)[0]!.trim();
    const locality = lodgingAnchor.startsWith(lodgingLocation)
      ? lodgingAnchor.slice(lodgingLocation.length).replace(/^[\p{Script=Han}]{1,8}?区/u, "") : "";
    return [...new Set([lodgingAnchor, locality ? `${lodgingCity}${locality}` : "", locality, lodgingCity].filter(Boolean))];
  }
  // An other/free-only day has no POI anchor.  Keep hotel search viable by using
  // the locked planning city instead of accidentally querying an activity title.
  if (!lodgingCity) return spotName ? [spotName] : (toPlatformShortLocationName(text(preferredCity)) ? [toPlatformShortLocationName(text(preferredCity))] : []);
  if (!spotName || (spotCity && spotCity !== lodgingCity)) return [lodgingCity];
  return [spotName, lodgingCity];
}

/**
 * 可配置住宿日不得超过产品 nights。AI 偶尔会给送站日也填酒店，
 * 会导致 VBK 多建住宿段；保留最早的住宿日，后续统一标为“无”。
 */
export function limitItineraryHotelStays(
  itinerary: Array<Record<string, unknown>>,
  nights: number | undefined,
): void {
  if (!Number.isInteger(nights) || nights === undefined || nights < 0) return;
  let remaining = nights;
  for (const day of itinerary) {
    if (!hasItineraryHotelStay(day.hotel)) continue;
    if (remaining > 0) {
      remaining -= 1;
      continue;
    }
    day.hotel = "无";
    delete day.hotelCandidates;
    delete day.hotelDescription;
  }
}
