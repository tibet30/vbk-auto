/**
 * 阶段 B：已选 place { poiId, ... } → searchImage → imageIds → getImageInfo。
 *
 *   - searchCtripLibraryImagesForPlace：对外入口；
 *   - callSearchImage：私有 BrowserView fetch 封装；
 *   - callSearchImage 支持 sources 兜底（供应商图库无图时回退到 source 3）；
 *
 * 任意步骤抛错向上传播（logger 已记录失败原因）；imageIds 为空时走「无图」分支。
 */

import type {
  CtripLibraryImageCandidate,
  CtripLibraryPlaceCandidate,
  CtripLibrarySearchResult,
} from "../../../shared/contracts-types.js";
import { fetchCtripImageInfoMap } from "../ctrip-image-info.js";
import { vbkSessionRequest } from "../vbk-session-request.js";
import {
  SILENT_COVER_PLACE_LOGGER,
  type CoverPlaceSearchLogger,
  type CoverPlaceSearchSessionContext,
} from "../cover-place-search-logger.js";
import {
  SEARCH_IMAGE_ENDPOINT,
  CTRIP_LIBRARY_BROWSER_REQUEST_TIMEOUT_MS,
  CTRIP_LIBRARY_EVALUATE_TIMEOUT_MS,
  CTRIP_LIBRARY_REFERRER,
  EMPTY_CTRIP_SESSION_CONTEXT,
  type CtripLibrarySearchBrowser,
  type SearchImageResponse,
  type SuggestPoiParsedPoi,
  buildSearchImageRequest,
  parseSearchImagePayload,
  positiveInteger,
  timeoutOrDefault,
} from "../ctrip-library-protocol.js";
import type { SearchCtripLibraryOptions } from "./options.js";
import { buildCandidateFromImageInfo } from "./candidates.js";

export async function searchCtripLibraryImagesForPlace(
  browser: CtripLibrarySearchBrowser,
  args: { keyword: string; place: CtripLibraryPlaceCandidate | SuggestPoiParsedPoi },
  options: SearchCtripLibraryOptions = {},
): Promise<CtripLibrarySearchResult> {
  const trimmed = (args.keyword ?? "").trim();
  if (!trimmed) throw new Error("查询携程图库必须提供景点关键词。");
  const placePoiId = positiveInteger((args.place as { poiId?: unknown })?.poiId);
  const placeName = typeof (args.place as { poiName?: unknown })?.poiName === "string"
    ? ((args.place as { poiName: string }).poiName).trim()
    : "";
  if (placePoiId === null || !placeName) {
    throw new Error("阶段 B 必须传入合法的 place（poiId + poiName 必填）。");
  }
  const logger = options.logger ?? SILENT_COVER_PLACE_LOGGER;
  const fetchedAt = new Date().toISOString();
  const emitSearchStart = options.emitSearchStart ?? true;
  if (emitSearchStart) {
    logger({
      event: "search-start",
      keyword: `${trimmed} (selected: ${placeName})`,
    });
  }

  // 步骤 1：searchImage → imageIds
  let searchImage = await callSearchImage(browser, placePoiId, options, logger);
  // VBK 的供应商图库（sources 1/9）可能没有当前 POI 素材，而攻略图库
  // （source 3）仍有可用图片。仅在首选渠道为空时回退，避免把"渠道无图"
  // 误判成"POI 无图"并永久阻断 readiness。
  if (searchImage.imageIds.length === 0) {
    searchImage = await callSearchImage(browser, placePoiId, options, logger, [3]);
  }

  // 步骤 2：getImageInfo → imageId → CtripLibraryImageInfo
  if (searchImage.imageIds.length === 0) {
    logger({
      event: "skip-image-info",
      reason: "searchImage 未返回 imageId（无图）",
      candidateCount: 0,
    });
    return {
      keyword: trimmed,
      poi: placeName,
      candidates: [],
      fetchedAt,
    };
  }
  logger({ event: "image-ids-extracted", imageIds: searchImage.imageIds });
  const infoMap = await fetchCtripImageInfoMap(browser, searchImage.imageIds, {
    browserRequestTimeoutMs: options.browserRequestTimeoutMs,
    evaluateTimeoutMs: options.evaluateTimeoutMs,
  });

  // 步骤 3：按 searchImage 顺序拼装 candidates
  const candidates: CtripLibraryImageCandidate[] = [];
  const placePoi: SuggestPoiParsedPoi = { poiId: placePoiId, poiName: placeName };
  for (let index = 0; index < searchImage.imageIds.length; index += 1) {
    const imageId = searchImage.imageIds[index];
    const info = infoMap.get(imageId);
    candidates.push(buildCandidateFromImageInfo({
      imageId,
      index,
      poi: placePoi,
      info,
    }));
  }
  return {
    keyword: trimmed,
    poi: placeName,
    candidates,
    fetchedAt,
  };
}

async function callSearchImage(
  browser: CtripLibrarySearchBrowser,
  poiId: number,
  options: SearchCtripLibraryOptions,
  logger: CoverPlaceSearchLogger = SILENT_COVER_PLACE_LOGGER,
  sources?: ReadonlyArray<number>,
): Promise<SearchImageResponse> {
  const request = buildSearchImageRequest({ poiId, sources });
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
      endpoint: SEARCH_IMAGE_ENDPOINT,
      body: request,
      browserRequestTimeoutMs,
      evaluateTimeoutMs,
      errorLabel: "searchImage",
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
      event: "searchImage-failure",
      message,
      httpStatus: 0,
      durationMs: 0,
      ctx: EMPTY_CTRIP_SESSION_CONTEXT,
    });
    throw error;
  }

  if (summary.status < 200 || summary.status >= 300) {
    logger({
      event: "searchImage-failure",
      message: `HTTP ${summary.status}`,
      httpStatus: summary.status,
      durationMs: summary.durationMs,
      ctx: summary.ctx,
    });
    throw new Error(`searchImage HTTP ${summary.status}`);
  }
  let detail: SearchImageResponse;
  try {
    detail = parseSearchImagePayload(summary.payload, summary.status);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger({
      event: "searchImage-failure",
      message,
      httpStatus: summary.status,
      durationMs: summary.durationMs,
      ctx: summary.ctx,
    });
    throw error;
  }
  logger({
    event: "searchImage-success",
    httpStatus: detail.httpStatus,
    ack: detail.businessStatus,
    imageIdCount: detail.imageIds.length,
    durationMs: summary.durationMs,
    ctx: summary.ctx,
  });
  return detail;
}