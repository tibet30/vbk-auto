/**
 * 携程酒店检索：以每日末景点为锚点，先取携程区域/地标，再从酒店列表 SSR
 * 中提取可回写的 hotelId。保留原定住宿地点边界，按实际评级、距离稳定排序；
 * 最多取五家，至少有一家有效候选即可继续。
 */

import { hotelLocalitySearchArgs, nightlyHotelAlternatives } from "./ctrip-hotel-locality.js";
import type { Page } from "playwright";
import type { CtripHotelCandidate } from "../../shared/contracts-types.js";
import { hotelDiamondFromTier } from "../../shared/hotel-tiers.js";
import { hasItineraryHotelStay } from "../../shared/itinerary-hotel.js";
import { toPlatformShortLocationName } from "../../shared/location-short-name.js";
import { itineraryAttractions } from "../../shared/itinerary-activity-kind.js";
import { toWritableAdministrativeCityName, hotelLocationFromHotelText } from "../../shared/region-overrides.js";
import { reusableHotelCandidates, reusableHotelCandidatesFromPool } from "./ctrip-hotel-candidate-cache.js";

export const CTRIP_HOTEL_SUGGEST_ENDPOINT = "https://m.ctrip.com/restapi/soa2/21881/json/gaHotelSearchEngine";
export { HOTEL_RESOURCE_CANDIDATE_COUNT } from "../../shared/hotel-candidate-counts.js";

type Coord = { latitude: number; longitude: number };
import type { HotelSearchContext as Context } from "./ctrip-hotel-search-types.js";
import { extractCtripHotelListFromHtml, rankCtripHotelCandidates, HotelCandidatesUnavailableError, HotelSearchEmptyResultError } from "./ctrip-hotel-list-parser.js";
export { extractCtripHotelListFromHtml, hotelCandidatesForTier } from "./ctrip-hotel-list-parser.js";
import { hotelTierForStay, type HotelStayRequirement } from "../../shared/hotel-stay-requirement.js";

export function buildHotelListUrl(args: { cityId: number; cityName?: string; zoneId?: string; checkin: string; checkout: string; hotelTier?: string; anchor?: Context }) {
  const diamond = args.anchor?.requirement?.diamond ?? hotelDiamondFromTier(args.hotelTier);
  // 携程消费者 UI 的 3/4/5 钻筛选已逐项核验；筛选后仍逐张核对评级类型和城市。
  // cityId 是酒店归属的唯一筛选锚点，后续仍以每张卡的 positionInfo.cityId 二次校验。
  const query = diamond
    ? new URLSearchParams({
      cityId: String(args.cityId), cityName: args.cityName ?? "", destName: args.cityName ?? "",
      checkin: args.checkin, checkout: args.checkout, crn: "1",
      listFilters: `29~1*29*1~1*2,17~1*17*1,16~${diamond}*16*${diamond},80~2*80*2`,
      locale: "zh-CN", old: "1",
    })
    : new URLSearchParams({ city: String(args.cityId), checkin: args.checkin, checkout: args.checkout, v2_mod: "24" });
  if (args.zoneId?.trim()) query.set("zone", args.zoneId.trim());
  if (args.anchor?.requirement?.maxDistanceKm !== undefined) {
    const anchor = args.anchor;
    query.set("searchWord", anchor.name);
    query.set("searchType", "LM");
    query.set("searchValue", `13|${anchor.id}*18*${anchor.coordinate.latitude}|${anchor.coordinate.longitude}|${anchor.name}|${anchor.id}|2`);
  }
  return `https://hotels.ctrip.com/hotels/list?${query.toString()}`;
}

/** 规划没有固定出团日；用 90 天后的连续一晚拿到可订酒店与稳定 hotelId。 */
export function nextHotelSearchDates(now = new Date()) {
  const checkin = new Date(now);
  checkin.setDate(checkin.getDate() + 90);
  const checkout = new Date(checkin);
  checkout.setDate(checkout.getDate() + 1);
  return { checkin: localDate(checkin), checkout: localDate(checkout) };
}

export async function fetchCtripHotelContext(keyword: string, fetcher: typeof fetch = fetch): Promise<unknown[]> {
  const name = keyword.trim();
  if (!name) throw new Error("酒店检索缺少当日末景点名称。");
  const response = await fetcher(CTRIP_HOTEL_SUGGEST_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      keyword: name, searchType: "H", platform: "online", pageID: "102001",
      head: { Locale: "zh-CN", LocaleController: "zh_cn", Currency: "CNY", PageId: "102001", group: "ctrip" },
    }),
  });
  if (!response.ok) throw new Error(`携程酒店地标查询失败：HTTP ${response.status}`);
  const payload = await response.json() as Record<string, unknown>;
  if (payload.Result === false) throw new Error(`携程酒店地标查询被拒绝：${String(payload.ErrorCode ?? "unknown")}`);
  const root = record(payload.Response);
  return Array.isArray(root?.searchResults) ? root!.searchResults : [];
}

export function selectCtripHotelContext(rows: unknown[], args: { anchorName: string; preferredCity?: string; requirePreferredCity?: boolean; requirement?: HotelStayRequirement }): Context {
  args = hotelLocalitySearchArgs(rows, args);
  const anchor = normalise(args.anchorName);
  const city = normalise(toPlatformShortLocationName(args.preferredCity));
  const candidates = rows.flatMap((value) => {
    const row = record(value);
    const id = text(row?.id); const cityId = positive(row?.cityId); const coordinate = coordinates(row);
    if (!row || !id || !cityId || !coordinate) return [];
    const word = text(row.word);
    const name = word || text(row.displayName);
    if (!name) return [];
    const rowCity = text(row.cityName);
    const type = text(row.type);
    const sameCity = Boolean(city && normalise(toPlatformShortLocationName(rowCity)) === city);
    if (args.requirePreferredCity && city && !sameCity) return [];
    const locality = args.requirement?.anchorName.replace(/(?:市|县|镇|村)$/u, "");
    if (args.requirement?.maxDistanceKm !== undefined && locality && !name.includes(locality)) return [];
    // City suggestions often have no coordinates. Their municipal landmark
    // represents the city center; a scenic spot sharing the prefix does not.
    const cityAnchor = city && normalise(toPlatformShortLocationName(args.anchorName)) === city;
    const municipalAnchor = cityAnchor && /人民政府$/u.test(name)
      && normalise(toPlatformShortLocationName(name.replace(/(?:市|县)?人民政府$/u, ""))) === city;
    const score = (sameCity ? 100 : 0)
      + (municipalAnchor ? 60 : 0)
      + (normalise(word) === anchor ? 40 : normalise(name) === anchor ? 30 : normalise(name).includes(anchor) ? 20 : 0)
      + (/Markland|Zone/i.test(type) ? 10 : 0);
    return [{ id, cityId, cityName: rowCity, name, coordinate, score, ...(args.requirement ? { requirement: args.requirement } : {}) }];
  });
  const selected = candidates.sort((left, right) => right.score - left.score || left.name.localeCompare(right.name, "zh-CN"))[0];
  if (selected && !city && candidates.some(candidate => candidate.score === selected.score && candidate.cityId !== selected.cityId)) {
    throw new Error(`住宿地标「${args.anchorName}」在多个城市同名，需确认每日住宿城市后再查询。`);
  }
  if (!selected) throw new Error(`携程未找到${city || "目标城市"}内可定位的酒店检索地标：${args.anchorName}`);
  return selected;
}

/** 在已通过 VbkBrowser.navigate 进入 hotels.ctrip.com 列表页后提取 SSR 初始数据。 */
export async function readCtripHotelCandidates(page: Page, anchor: Context, hotelTier?: string): Promise<CtripHotelCandidate[]> {
  const rows = await page.evaluate(() => {
    const data = (window as unknown as { __NEXT_DATA__?: { props?: { pageProps?: { initListData?: { hotelList?: unknown[] } } } } }).__NEXT_DATA__;
    return data?.props?.pageProps?.initListData?.hotelList ?? [];
  });
  return rankCtripHotelCandidates(rows, anchor, hotelTier);
}

export async function fetchCtripHotelCandidates(anchor: Context, dates: { checkin: string; checkout: string }, fetcher: typeof fetch = fetch, hotelTier?: string, rankingTier = hotelTier) {
  // 明确镇内/景区住宿使用官方地标筛选，并再次核对每张卡的城市和距离。
  // 登录、验证码与网络失败保留为查询失败，不能作为降档依据。
  const response = await fetcher(buildHotelListUrl({ cityId: anchor.cityId, cityName: anchor.cityName, ...dates, hotelTier, anchor }), {
    headers: { "accept-language": "zh-CN,zh;q=0.9", "user-agent": "Mozilla/5.0" },
  });
  if (!response.ok) throw new Error(`携程酒店列表查询失败：HTTP ${response.status}`);
  return rankCtripHotelCandidates(extractCtripHotelListFromHtml(await response.text()), anchor, rankingTier);
}

export async function resolveItineraryHotelCandidates(
  itinerary: Array<Record<string, unknown>>,
  preferredCity?: string,
  nights?: number,
  hotelTier?: string,
  onProgress?: (result: { itinerary: Array<Record<string, unknown>>; dailyCandidates: Array<{ day: number; candidates: CtripHotelCandidate[] }>; searchDates: { checkin: string; checkout: string } }) => Promise<void> | void,
  requirements?: Map<number, HotelStayRequirement>,
  allowDowngrade: boolean | Map<number, boolean> = false,
  candidatePool: CtripHotelCandidate[] = [],
) {
  const dates = nextHotelSearchDates();
  const dailyCandidates: Array<{ day: number; candidates: CtripHotelCandidate[] }> = [];
  const nextItinerary = structuredClone(itinerary);
  limitItineraryHotelStays(nextItinerary, nights);
  const failures: string[] = [];
  for (const [index, day] of nextItinerary.entries()) {
    if (!shouldResolveItineraryHotelForDay(day, index, nights)) continue;
    const requirement = requirements?.get(Number(day.day));
    const dayTier = hotelTierForStay(hotelTier, requirement);
    const saved = reusableHotelCandidates(day, dayTier, requirement);
    const reusable = saved ?? reusableHotelCandidatesFromPool(candidatePool, dayTier, requirement);
    if (reusable) {
      const selected = reusable[0]!;
      day.hotel = selected.hotelName;
      day.hotelCandidates = reusable;
      day.hotelRequirement = { anchorName: selected.anchorName, cityName: selected.cityName, ...requirement,
        diamond: selected.diamond, ratingType: selected.ratingType ?? "diamond" };
      day.hotelDescription = `优先入住${selected.hotelName}（${selected.diamond === 0 ? "无" : selected.diamond}${selected.ratingType === "homestay" ? "民宿圆钻" : selected.ratingType === "star" ? "星" : "钻"}，距${selected.anchorName}${selected.distanceKm}km）；备选：${reusable.slice(1).map(item => item.hotelName).join("、")}`;
      dailyCandidates.push({ day: Number(day.day), candidates: reusable });
      await onProgress?.({ itinerary: structuredClone(nextItinerary), dailyCandidates: structuredClone(dailyCandidates), searchDates: dates });
      continue;
    }
    const contextCity = requirement?.anchorName ? requirement.cityName : hotelSearchContextCityForDay(day, preferredCity);
    const anchorNames = requirement?.maxDistanceKm !== undefined
      ? [...new Set([requirement.anchorName, ...(hotelSearchAnchorNames(day, preferredCity).filter(name => name.includes(requirement.anchorName.replace(/(?:镇|村)$/u, ""))))])]
      : requirement?.anchorName
        ? [requirement.anchorName]
      : hotelSearchAnchorNames(day, preferredCity);
    let anchor: Context | undefined;
    let candidates: CtripHotelCandidate[] | undefined;
    try {
      for (const anchorName of anchorNames) {
        const contexts = await fetchCtripHotelContext(anchorName);
        try {
          anchor = selectCtripHotelContext(contexts, {
            anchorName, preferredCity: nightlyHotelAlternatives(text(day.hotel)).length ? undefined : contextCity, requirePreferredCity: Boolean(contextCity) && !nightlyHotelAlternatives(text(day.hotel)).length,
            requirement: nightlyHotelAlternatives(text(day.hotel)).length ? { ...requirement, anchorName, maxDistanceKm: requirement?.maxDistanceKm ?? 5 } : requirement,
          });
          candidates = await fetchHotelCandidatesWithFallback(anchor, dates, dayTier, anchor.requirement ?? requirement, (allowDowngrade instanceof Map ? allowDowngrade.get(Number(day.day)) !== false : allowDowngrade));
          break;
        } catch (error) {
          if (anchorName === anchorNames.at(-1) || !(error instanceof HotelCandidatesUnavailableError || error instanceof HotelSearchEmptyResultError || error instanceof Error && /未找到.*酒店检索地标/u.test(error.message))) throw error;
        }
      }
      if (!anchor) throw new Error("缺少可定位的酒店检索地标。");
      if (!candidates?.length) throw new Error("未取得有效酒店候选。");
    } catch (error) {
      const city = contextCity || anchor?.cityName || "未识别城市";
      const diamond = requirement?.diamond ?? hotelDiamondFromTier(hotelTier);
      const reason = error instanceof Error ? error.message : String(error);
      const failure = `第 ${Number(day.day) || index + 1} 天住宿（检索城市：${city}，要求：${diamond ? `当地${diamond}钻` : hotelTier || "未配置档次"}）未完成：${reason}`;
      if (!onProgress) throw new Error(failure);
      failures.push(failure);
      continue;
    }
    const selected = candidates[0]!;
    const requestedDiamond = requirement?.diamond ?? hotelDiamondFromTier(hotelTier);
    day.hotelRequirement = { anchorName: anchor!.name, cityName: anchor!.cityName, ...requirement, ...anchor!.requirement,
      diamond: selected.diamond, ratingType: selected.ratingType ?? "diamond" };
    day.hotel = selected.hotelName;
    day.hotelCandidates = candidates;
    day.hotelDescription = `优先入住${selected.hotelName}（${selected.diamond === 0 ? "无" : selected.diamond}${selected.ratingType === "homestay" ? "民宿圆钻" : selected.ratingType === "star" ? "星" : "钻"}，距${anchor!.name}${selected.distanceKm}km）；备选：${candidates.slice(1).map((item) => item.hotelName).join("、")}`;
    if (requestedDiamond && selected.diamond < requestedDiamond) day.hotelDescription += `；目标${requestedDiamond}钻在原定住宿地点未取得合格候选，按允许降档规则改为${selected.diamond === 0 ? "无" : selected.diamond}钻，住宿地点保持不变。`;
    day.description = text(day.description).replace("入住当地住宿（待匹配）", `入住${selected.hotelName}`);
    dailyCandidates.push({ day: Number(day.day), candidates });
    await onProgress?.({ itinerary: structuredClone(nextItinerary), dailyCandidates: structuredClone(dailyCandidates), searchDates: dates });
  }
  if (failures.length) throw new Error(`已取得 ${dailyCandidates.length} 天酒店候选，以下日期仍需核验：\n${failures.join("\n")}`);
  if (!dailyCandidates.length) throw new Error("行程没有需住宿的日期，无法录入酒店候选。");
  return { itinerary: nextItinerary, dailyCandidates, searchDates: dates };
}

async function fetchHotelCandidatesWithFallback(anchor: Context, dates: { checkin: string; checkout: string }, hotelTier?: string, requirement?: HotelStayRequirement, allowDowngrade = false) {
  const target = anchor.requirement?.diamond ?? hotelDiamondFromTier(hotelTier);
  const declared = requirement?.ratingAlternatives?.length
    ? requirement.ratingAlternatives.map(item => ({ ratingType: item.ratingType, diamond: item.diamond ?? (item.ratingType === "diamond" ? target : undefined) }))
    : [{ ratingType: requirement?.ratingType, diamond: target }];
  const attempts = declared.flatMap(item => {
    const grades = item.diamond && allowDowngrade
      ? Array.from({ length: item.diamond + 1 }, (_, index) => item.diamond! - index)
      : [item.diamond];
    return grades.map(diamond => ({ ...item, diamond }));
  });
  let failure: unknown;
  for (const attempt of attempts) {
    try {
      const searchTier = hotelTier;
      const rankingTier = attempt.ratingType === "homestay" ? undefined : hotelTier;
      return await fetchCtripHotelCandidates({ ...anchor, requirement: { anchorName: anchor.name, ...anchor.requirement,
        ...(attempt.diamond !== undefined ? { diamond: attempt.diamond } : {}), ...(attempt.ratingType ? { ratingType: attempt.ratingType } : {}) } }, dates, fetch, searchTier, rankingTier);
    } catch (error) {
      // 仅对已解析的空结果或候选不匹配尝试下一档；网络/登录/解析异常直接上报。
      // 空列表也可能来自验证码，因此不能据此声称当地没有酒店。
      if (!(error instanceof HotelCandidatesUnavailableError) && !(error instanceof HotelSearchEmptyResultError)) throw error;
      failure = error;
    }
  }
  throw failure;
}

/**
 * 行程录入页的酒店节点使用携程平台酒店。AI 有时只写了产品 nights，
 * 但每日 hotel 仍为空；这时按默认行程语义把前 N 天视为住宿日，
 * 让酒店候选解析补齐携程酒店。明确写“无 / 不住宿”的日子仍然跳过。
 */
export function shouldResolveItineraryHotelForDay(day: Record<string, unknown>, index: number, nights?: number): boolean {
  if (hasItineraryHotelStay(day.hotel)) return true;
  if (text(day.hotel)) return false;
  return Number.isInteger(nights) && nights !== undefined && nights > 0 && index < nights;
}

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

function coordinates(row: Record<string, unknown> | null): Coord | null {
  if (!row) return null;
  const latitude = firstCoordinate(row.gdLat, row.gLat, row.lat);
  const longitude = firstCoordinate(row.gdLon, row.gLon, row.lon);
  return latitude !== null && longitude !== null ? { latitude, longitude } : null;
}
function firstCoordinate(...values: unknown[]): number | null {
  for (const value of values) { const parsed = number(value); if (parsed !== null && parsed !== 0) return parsed; }
  return null;
}
function record(value: unknown): Record<string, unknown> | null { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null; }
function text(value: unknown): string { return typeof value === "string" ? value.trim() : ""; }
function positive(value: unknown): number | null { const parsed = Number(value); return Number.isInteger(parsed) && parsed > 0 ? parsed : null; }
function number(value: unknown): number | null { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : null; }
function normalise(value: string): string { return value.replace(/\s+/g, "").replace(/[（(].*?[）)]/g, "").trim(); }
function escapeRegExp(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function localDate(value: Date): string { return [value.getFullYear(), String(value.getMonth() + 1).padStart(2, "0"), String(value.getDate()).padStart(2, "0")].join("-"); }
