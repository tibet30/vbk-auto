/**
 * 阶段 A：keyword → suggestpoi.json → 地址 / 景点候选列表。
 *
 *   - searchCtripLibraryPlaces：对外入口；
 *   - callSuggestPoiPlaces：私有 BrowserView fetch 封装，含 logger 事件；
 *
 * 业务失败 / 网络失败向上抛错（logger 已记录失败原因）；合法候选至少要有
 * poiId + poiName；业务 Ack 成功但无合法候选时返回空 places（不抛错），
 * UI 走"无结果"分支。
 */

import type {
  CtripLibraryPlaceCandidate,
  CtripLibraryPlaceSearchResult,
} from "../../../shared/contracts-types.js";
import { vbkSessionRequest } from "../vbk-session-request.js";
import {
  SILENT_COVER_PLACE_LOGGER,
  type CoverPlaceSearchLogger,
  type CoverPlaceSearchSessionContext,
} from "../cover-place-search-logger.js";
import {
  SUGGESTPOI_ENDPOINT,
  CTRIP_LIBRARY_BROWSER_REQUEST_TIMEOUT_MS,
  CTRIP_LIBRARY_EVALUATE_TIMEOUT_MS,
  CTRIP_LIBRARY_REFERRER,
  EMPTY_CTRIP_SESSION_CONTEXT,
  type CtripLibrarySearchBrowser,
  type SuggestPoiPlacesResult,
  buildSuggestPoiRequest,
  parseSuggestPoiPlaces,
  timeoutOrDefault,
} from "../ctrip-library-protocol.js";
import type { SearchCtripLibraryOptions } from "./options.js";
import { buildPlaceCandidateFromPoi } from "./candidates.js";

export async function searchCtripLibraryPlaces(
  browser: CtripLibrarySearchBrowser,
  keyword: string,
  options: SearchCtripLibraryOptions = {},
): Promise<CtripLibraryPlaceSearchResult> {
  const trimmed = keyword.trim();
  if (!trimmed) throw new Error("查询携程图库必须提供景点关键词。");
  const logger = options.logger ?? SILENT_COVER_PLACE_LOGGER;
  const fetchedAt = new Date().toISOString();
  logger({ event: "search-start", keyword: trimmed });
  const suggest = await callSuggestPoiPlaces(browser, trimmed, options, logger);
  const places: CtripLibraryPlaceCandidate[] = suggest.places.map((poi, index) =>
    buildPlaceCandidateFromPoi(poi, index),
  );
  return { keyword: trimmed, places, fetchedAt };
}

/**
 * 阶段 A 的 BrowserView 入口：suggestpoi.json → 所有合法 POI 候选。
 *  - logger 事件：search-start（阶段 A 自己发出，不与 searchCtripLibraryPlaces
 *    重复）；
 *  - 业务失败 / 网络失败向上抛错，并附带 logger 事件；
 *  - 成功时返回 SuggestPoiPlacesResult（places 已 dedup）；
 *  - 与 callSearchImage 不同：阶段 A 不再要求 "至少 1 个" 候选 —— 空 places
 *    让 UI 走"无结果"分支。
 */
async function callSuggestPoiPlaces(
  browser: CtripLibrarySearchBrowser,
  keyword: string,
  options: SearchCtripLibraryOptions,
  logger: CoverPlaceSearchLogger = SILENT_COVER_PLACE_LOGGER,
): Promise<SuggestPoiPlacesResult> {
  const request = buildSuggestPoiRequest(keyword);
  const browserRequestTimeoutMs = timeoutOrDefault(
    options.browserRequestTimeoutMs,
    CTRIP_LIBRARY_BROWSER_REQUEST_TIMEOUT_MS,
  );
  const evaluateTimeoutMs = timeoutOrDefault(
    options.evaluateTimeoutMs,
    CTRIP_LIBRARY_EVALUATE_TIMEOUT_MS,
  );
  let summary: { status: number; payload: unknown; durationMs: number; ctx: CoverPlaceSearchSessionContext };
  try {
    summary = await vbkSessionRequest(browser, {
      endpoint: SUGGESTPOI_ENDPOINT,
      body: request,
      browserRequestTimeoutMs,
      evaluateTimeoutMs,
      errorLabel: "suggestPoi",
      headers: {
        "accept-language": "zh-CN,zh;q=0.9",
        cookieorigin: "https://vbooking.ctrip.com",
        "x-input-locale": "zh-CN",
      },
      referrer: CTRIP_LIBRARY_REFERRER,
      referrerPolicy: "strict-origin-when-cross-origin",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger({
      event: "suggest-failure",
      message,
      httpStatus: 0,
      durationMs: 0,
      candidateCount: 0,
      ctx: EMPTY_CTRIP_SESSION_CONTEXT,
    });
    throw error;
  }

  if (summary.status < 200 || summary.status >= 300) {
    logger({
      event: "suggest-failure",
      message: `HTTP ${summary.status}`,
      httpStatus: summary.status,
      durationMs: summary.durationMs,
      candidateCount: 0,
      ctx: summary.ctx,
    });
    throw new Error(`suggestPoi 返回 HTTP ${summary.status}`);
  }
  let detail: SuggestPoiPlacesResult;
  try {
    detail = parseSuggestPoiPlaces(summary.payload, summary.status);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger({
      event: "suggest-failure",
      message,
      httpStatus: summary.status,
      durationMs: summary.durationMs,
      candidateCount: 0,
      ctx: summary.ctx,
    });
    throw error;
  }
  if (detail.places.length === 0) {
    logger({
      event: "suggest-failure",
      message: `未找到匹配 POI（keyword=${JSON.stringify(keyword)}）`,
      httpStatus: summary.status,
      durationMs: summary.durationMs,
      candidateCount: 0,
      ctx: summary.ctx,
    });
  } else {
    const first = detail.places[0];
    logger({
      event: "suggest-success",
      poiName: first.poiName,
      poiId: first.poiId,
      durationMs: summary.durationMs,
      candidateCount: detail.places.length,
      ctx: summary.ctx,
    });
  }
  return detail;
}