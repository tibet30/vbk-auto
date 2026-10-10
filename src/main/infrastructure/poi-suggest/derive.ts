/**
 * POI 候选查询的对外"派生"入口：
 *   - suggestPoi：返回 best（最常用于规划子系统）；
 *   - suggestPoiDetail：返回 detail（带 httpStatus / businessStatus / candidates）；
 *   - suggestPoiDetailWithRawPayload：返回 detail + 原始 payload；
 *   - queryPoiSuggestWithDestinationFallback：先尝试 keyword，未命中时再尝试
 *     「剥掉 destinationCity 前缀」后的版本（VBK 经常把"北京故宫"当字面量）。
 */

import type { PoiSuggestion } from "../../../shared/contracts.js";
import type { PoiSuggestDetailResult } from "../../../shared/contracts.js";
import type { PoiSuggestDetailResultWithRawPayload } from "../poi-suggest-detail.js";
import type { PoiSuggestBrowser, PoiSuggestTimeoutOptions } from "./types.js";
import { queryPoiSuggest } from "./query.js";

export async function suggestPoiDetail(
  browser: PoiSuggestBrowser,
  keyword: string,
  options?: PoiSuggestTimeoutOptions,
): Promise<PoiSuggestDetailResult> {
  const { rawPayload: _rawPayload, ...detail } = await queryPoiSuggestWithDestinationFallback(browser, keyword, options);
  return detail;
}

export async function suggestPoiDetailWithRawPayload(
  browser: PoiSuggestBrowser,
  keyword: string,
  options?: PoiSuggestTimeoutOptions,
): Promise<PoiSuggestDetailResultWithRawPayload> {
  return queryPoiSuggest(browser, keyword, options);
}

export async function suggestPoi(
  browser: PoiSuggestBrowser,
  keyword: string,
  options?: PoiSuggestTimeoutOptions,
): Promise<PoiSuggestion | null> {
  return (await queryPoiSuggestWithDestinationFallback(browser, keyword, options)).best;
}

async function queryPoiSuggestWithDestinationFallback(
  browser: PoiSuggestBrowser,
  keyword: string,
  options: PoiSuggestTimeoutOptions = {},
): Promise<PoiSuggestDetailResultWithRawPayload> {
  const first = await queryPoiSuggest(browser, keyword, options);
  if (first.best) return first;
  const city = options.destinationCity?.trim() ?? "";
  const trimmedKeyword = keyword.trim();
  if (!city || !trimmedKeyword.startsWith(city) || trimmedKeyword.length <= city.length + 1) return first;
  // VBK often searches "北京故宫" as a literal string and returns a noisy
  // list. A second authenticated query for the city-local name lets the
  // strict matcher choose the canonical "故宫博物院" without guessing an ID.
  return queryPoiSuggest(browser, trimmedKeyword.slice(city.length).trim(), options);
}