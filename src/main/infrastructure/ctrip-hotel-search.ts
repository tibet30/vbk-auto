/**
 * 携程酒店检索：以每日末景点为锚点，先取携程区域/地标，再从酒店列表 SSR
 * 中提取可回写的 hotelId。候选不再设置距离上限，按钻级、距离稳定排序；
 * 最多取五家，至少有一家有效候选即可继续。
 */

import type { Page } from "playwright";
import type { CtripHotelCandidate } from "../../shared/contracts-types.js";
import { HOTEL_RESOURCE_CANDIDATE_COUNT } from "../../shared/hotel-candidate-counts.js";
import { hotelDiamondFromTier } from "../../shared/hotel-tiers.js";
import { hasItineraryHotelStay } from "../../shared/itinerary-hotel.js";
import { toPlatformShortLocationName } from "../../shared/location-short-name.js";
import { itineraryAttractions } from "../../shared/itinerary-activity-kind.js";

export const CTRIP_HOTEL_SUGGEST_ENDPOINT = "https://m.ctrip.com/restapi/soa2/21881/json/gaHotelSearchEngine";
export { HOTEL_RESOURCE_CANDIDATE_COUNT } from "../../shared/hotel-candidate-counts.js";

type Coord = { latitude: number; longitude: number };
type Context = { id: string; cityId: number; cityName: string; name: string; coordinate: Coord };

export function buildHotelListUrl(args: { cityId: number; cityName?: string; zoneId?: string; checkin: string; checkout: string; hotelTier?: string }) {
  const diamond = hotelDiamondFromTier(args.hotelTier);
  // 携程消费者列表由实际 UI 选择“5钻”生成 listFilters；只使用已实测的 5 钻编码，
  // 其他档次维持既有公开列表路径，不能凭编码形状推测新的携程筛选参数。
  // cityId 是酒店归属的唯一筛选锚点，后续仍以每张卡的 positionInfo.cityId 二次校验。
  const query = diamond === 5
    ? new URLSearchParams({
      cityId: String(args.cityId), cityName: args.cityName ?? "", destName: args.cityName ?? "",
      checkin: args.checkin, checkout: args.checkout, crn: "1",
      listFilters: "29~1*29*1~1*2,17~1*17*1,16~5*16*5,80~2*80*2",
      locale: "zh-CN", old: "1",
    })
    : new URLSearchParams({ city: String(args.cityId), checkin: args.checkin, checkout: args.checkout, v2_mod: "24" });
  if (args.zoneId?.trim()) query.set("zone", args.zoneId.trim());
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

export function selectCtripHotelContext(rows: unknown[], args: { anchorName: string; preferredCity?: string; requirePreferredCity?: boolean }): Context {
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
    const score = (sameCity ? 100 : 0)
      + (normalise(word) === anchor ? 40 : normalise(name) === anchor ? 30 : normalise(name).includes(anchor) ? 20 : 0)
      + (/Markland|Zone/i.test(type) ? 10 : 0);
    return [{ id, cityId, cityName: rowCity, name, coordinate, score }];
  });
  const selected = candidates.sort((left, right) => right.score - left.score || left.name.localeCompare(right.name, "zh-CN"))[0];
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

export function extractCtripHotelListFromHtml(html: string): unknown[] {
  const chunks = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)]
    .map((match) => nextFlightText(match[1] ?? ""))
    .filter((value): value is string => Boolean(value));
  for (const chunk of chunks) {
    const marker = '"hotelList":';
    const index = chunk.indexOf(marker);
    if (index < 0) continue;
    const parsed = parseJsonValue(chunk.slice(index + marker.length));
    if (Array.isArray(parsed)) return parsed;
  }
  throw new Error("携程酒店列表页面未包含可解析的酒店数据。");
}

export async function fetchCtripHotelCandidates(anchor: Context, dates: { checkin: string; checkout: string }, fetcher: typeof fetch = fetch, hotelTier?: string) {
  // 地标页在部分账号分区会跳转携程登录页，并且个别景点页会返回空酒店卡片。
  // 改取同一携程列表的公开城市结果，并保留末景点坐标用于距离排序，
  // 不再因固定距离上限丢弃携程返回的有效酒店。
  const response = await fetcher(buildHotelListUrl({ cityId: anchor.cityId, cityName: anchor.cityName, ...dates, hotelTier }), {
    headers: { "accept-language": "zh-CN,zh;q=0.9", "user-agent": "Mozilla/5.0" },
  });
  if (!response.ok) throw new Error(`携程酒店列表查询失败：HTTP ${response.status}`);
  return rankCtripHotelCandidates(extractCtripHotelListFromHtml(await response.text()), anchor, hotelTier);
}

function rankCtripHotelCandidates(rows: unknown[], anchor: Context, hotelTier?: string): CtripHotelCandidate[] {
  if (!Array.isArray(rows) || !rows.length) throw new Error("携程酒店列表未返回可用候选（可能触发验证码或该日期无房）。");
  const parsed = rows.flatMap((row) => parseHotel(row, anchor));
  if (!parsed.length) throw new Error("携程未找到带有效 hotelId/钻级的酒店，无法继续酒店资源配置。");
  const candidates = hotelCandidatesForTier(parsed, hotelTier, `携程当前公开列表首屏在${anchor.cityName || "目标城市"}仅解析到 ${parsed.length} 家带有效ID和钻级的候选，尚未取得符合当地${hotelDiamondFromTier(hotelTier)}钻要求的酒店；这不能证明当地没有该档次酒店，需在正常登录会话中完成官方筛选后再核验。`);
  const sorted = candidates.sort((left, right) => right.diamond - left.diamond || left.distanceKm - right.distanceKm || right.score - left.score || left.hotelId - right.hotelId);
  const unique = [...new Map(sorted.map((candidate) => [candidate.hotelId, candidate])).values()].slice(0, HOTEL_RESOURCE_CANDIDATE_COUNT);
  if (unique.length === 0) {
    throw new Error("携程未找到带有效 hotelId/钻级的酒店，无法继续酒店资源配置。");
  }
  return unique;
}

export async function resolveItineraryHotelCandidates(
  itinerary: Array<Record<string, unknown>>,
  preferredCity?: string,
  nights?: number,
  hotelTier?: string,
) {
  const dates = nextHotelSearchDates();
  const dailyCandidates: Array<{ day: number; candidates: CtripHotelCandidate[] }> = [];
  const nextItinerary = structuredClone(itinerary);
  limitItineraryHotelStays(nextItinerary, nights);
  for (const [index, day] of nextItinerary.entries()) {
    if (!shouldResolveItineraryHotelForDay(day, index, nights)) continue;
    const spots = Array.isArray(day.spots) ? day.spots.map(record).filter(Boolean) : [];
    const last = spots.at(-1);
    const lodgingCity = hotelAnchorNameForDay(day, preferredCity);
    const spotCity = toPlatformShortLocationName(text(last?.city));
    const contextCity = lodgingCity || spotCity;
    const anchorNames = hotelSearchAnchorNames(day, contextCity);
    let anchor: Context | undefined;
    for (const anchorName of anchorNames) {
      const contexts = await fetchCtripHotelContext(anchorName);
      try {
        anchor = selectCtripHotelContext(contexts, {
          anchorName, preferredCity: contextCity, requirePreferredCity: Boolean(contextCity),
        });
        break;
      } catch (error) {
        if (anchorName === anchorNames.at(-1)) throw error;
      }
    }
    if (!anchor) throw new Error("缺少可定位的酒店检索地标。");
    let candidates: CtripHotelCandidate[];
    try {
      candidates = await fetchCtripHotelCandidates(anchor, dates, fetch, hotelTier);
    } catch (error) {
      const city = contextCity || anchor.cityName || "未识别城市";
      const diamond = hotelDiamondFromTier(hotelTier);
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`第 ${Number(day.day) || index + 1} 天住宿（检索城市：${city}，要求：${diamond ? `当地${diamond}钻` : hotelTier || "未配置档次"}）未完成：${reason}`);
    }
    const selected = candidates[0]!;
    day.hotel = selected.hotelName;
    day.hotelCandidates = candidates;
    day.hotelDescription = `优先入住${selected.hotelName}（${selected.diamond}钻，距${anchor.name}${selected.distanceKm}km）；备选：${candidates.slice(1).map((item) => item.hotelName).join("、")}`;
    day.description = text(day.description).replace("入住当地住宿（待匹配）", `入住${selected.hotelName}`);
    dailyCandidates.push({ day: Number(day.day), candidates });
  }
  if (!dailyCandidates.length) throw new Error("行程没有需住宿的日期，无法录入酒店候选。");
  return { itinerary: nextItinerary, dailyCandidates, searchDates: dates };
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
export function hotelCandidatesForTier(candidates: CtripHotelCandidate[], hotelTier?: string, unavailableMessage?: string): CtripHotelCandidate[] {
  const diamond = hotelDiamondFromTier(hotelTier);
  if (!diamond) return candidates;
  const matched = candidates.filter((candidate) => candidate.diamond === diamond);
  if (!matched.length) throw new Error(unavailableMessage || `携程当前结果未返回符合当地${diamond}钻要求的酒店候选；不能据此断定当地没有该档次酒店。`);
  return matched;
}

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
export function hotelSearchAnchorNames(day: Record<string, unknown>, preferredCity?: string): string[] {
  const rawSpots = Array.isArray(day.spots) ? day.spots.map(record).filter((spot): spot is Record<string, unknown> => Boolean(spot)) : [];
  const spots = itineraryAttractions(rawSpots) as Array<Record<string, unknown>>;
  const last = spots.at(-1);
  const spotName = text(last?.poiName) || text(last?.name);
  const spotCity = toPlatformShortLocationName(text(last?.city));
  const lodgingCity = hotelAnchorNameForDay(day, preferredCity);
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

function nextFlightText(source: string): string | null {
  if (!source.includes("initListData") || !source.includes("self.__next_f.push")) return null;
  const match = source.match(/^\s*self\.__next_f\.push\(([\s\S]*?)\);?\s*$/);
  if (!match) return null;
  try {
    const value = JSON.parse(match[1] ?? "");
    return findFlightText(value);
  } catch { return null; }
}
function findFlightText(value: unknown): string | null {
  if (typeof value === "string") return value.includes("initListData") ? value : null;
  if (!Array.isArray(value)) return null;
  for (const item of value) {
    const found = findFlightText(item);
    if (found) return found;
  }
  return null;
}
function parseJsonValue(source: string): unknown {
  const start = source.search(/[\[{]/);
  if (start < 0) return null;
  const open = source[start]!; const close = open === "[" ? "]" : "}";
  let depth = 0; let quote = ""; let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const current = source[index]!;
    if (quote) {
      if (escaped) escaped = false;
      else if (current === "\\") escaped = true;
      else if (current === quote) quote = "";
      continue;
    }
    if (current === '"') { quote = current; continue; }
    if (current === open) depth += 1;
    if (current === close && --depth === 0) {
      try { return JSON.parse(source.slice(start, index + 1)); } catch { return null; }
    }
  }
  return null;
}

function parseHotel(raw: unknown, anchor: Context): CtripHotelCandidate[] {
  const row = record(raw); const info = record(row?.hotelInfo); const summary = record(info?.summary);
  const nameInfo = record(info?.nameInfo); const star = record(info?.hotelStar); const comment = record(info?.commentInfo);
  const position = record(info?.positionInfo); const hotelId = positive(summary?.hotelId); const hotelName = text(nameInfo?.name);
  const diamond = positive(star?.star); const starType = number(star?.starType); const coordinate = hotelCoordinates(position?.mapCoordinate);
  const cityId = positive(position?.cityId); const cityName = text(position?.cityName);
  // 城市筛选页可能混入邻市卡片；缺少携程卡片城市 ID 也不能借锚点默认放行。
  // hotelTier 的“钻”只接受携程 diamond（starType 0）；星级酒店和民宿圆钻不是同一档位。
  if (!hotelId || !hotelName || !diamond || diamond > 5 || starType !== 0 || !coordinate || cityId !== anchor.cityId || !cityName) return [];
  const distanceKm = haversineKm(anchor.coordinate, coordinate);
  const score = number(comment?.commentScore) ?? 0;
  return [{ hotelId, hotelName, diamond, score, distanceKm: Math.round(distanceKm * 100) / 100,
    address: text(position?.address) || undefined, cityName,
    anchorName: anchor.name, anchorCityId: anchor.cityId }];
}

function hotelCoordinates(value: unknown): Coord | null {
  const rows = Array.isArray(value) ? value.map(record).filter(Boolean) : [];
  const sorted = rows.sort((left, right) => Number(left?.coordinateType ?? 9) - Number(right?.coordinateType ?? 9));
  for (const row of sorted) {
    const latitude = number(row?.latitude); const longitude = number(row?.longitude);
    if (latitude !== null && longitude !== null && (latitude !== 0 || longitude !== 0)) return { latitude, longitude };
  }
  return null;
}
function coordinates(row: Record<string, unknown> | null): Coord | null {
  if (!row) return null;
  // 携程经常同时返回 gdLat/gdLon=0 与有效的 gLat/gLon；0 不是可用坐标，
  // 不能因为它是数值就阻断后续字段的回退。
  const latitude = firstCoordinate(row.gdLat, row.gLat, row.lat);
  const longitude = firstCoordinate(row.gdLon, row.gLon, row.lon);
  return latitude !== null && longitude !== null ? { latitude, longitude } : null;
}
function firstCoordinate(...values: unknown[]): number | null {
  for (const value of values) {
    const parsed = number(value);
    if (parsed !== null && parsed !== 0) return parsed;
  }
  return null;
}
function haversineKm(left: Coord, right: Coord) {
  const radians = (value: number) => value * Math.PI / 180;
  const a = Math.sin(radians(right.latitude - left.latitude) / 2) ** 2
    + Math.cos(radians(left.latitude)) * Math.cos(radians(right.latitude)) * Math.sin(radians(right.longitude - left.longitude) / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
function record(value: unknown): Record<string, unknown> | null { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null; }
function text(value: unknown): string { return typeof value === "string" ? value.trim() : ""; }
function positive(value: unknown): number | null { const parsed = Number(value); return Number.isInteger(parsed) && parsed > 0 ? parsed : null; }
function number(value: unknown): number | null { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : null; }
function normalise(value: string): string { return value.replace(/\s+/g, "").replace(/[（(].*?[）)]/g, "").trim(); }
function escapeRegExp(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function localDate(value: Date): string { return [value.getFullYear(), String(value.getMonth() + 1).padStart(2, "0"), String(value.getDate()).padStart(2, "0")].join("-"); }
