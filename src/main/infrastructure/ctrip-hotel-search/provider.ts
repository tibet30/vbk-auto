import type { Page } from "playwright";
import type { CtripHotelCandidate } from "../../../shared/contracts-types.js";
import { hotelDiamondFromTier } from "../../../shared/hotel-tiers.js";
import type { HotelSearchContext as Context } from "../ctrip-hotel-search-types.js";
import { extractCtripHotelListFromHtml, rankCtripHotelCandidates } from "../ctrip-hotel-list-parser.js";
import { localDate, record } from "./helpers.js";

export const CTRIP_HOTEL_SUGGEST_ENDPOINT = "https://m.ctrip.com/restapi/soa2/21881/json/gaHotelSearchEngine";

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
