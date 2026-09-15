/**
 * 携程图库图片搜索（直接 BrowserView fetch 版）：
 *   - 不再依赖 VBK 当前页「从图库资源导入」弹窗；
 *   - 链路分两阶段：
 *       阶段 A：searchCtripLibraryPlaces
 *         调 suggestPoi（soa2/15638/suggestpoi.json）按景点关键词解析 POI 列表；
 *         返回的 places 含 poiId / poiName / 可选 address / province / city /
 *         district；UI 在地址列表里选中一项后再走阶段 B；
 *       阶段 B：searchCtripLibraryImagesForPlace
 *         接收已选 place { poiId, ... }，调 searchImage（soa2/12719/searchImage）
 *         拿 imageIds，再用 fetchCtripImageInfoMap 拉详情（thumbnail / preview /
 *         score / resolution / poiName / ...）；
 *   - 旧入口 searchCtripLibraryImages 保留为「自动取首个 POI」的兼容 wrapper，
 *     内部等价于「places → 取第一个 → searchImage → getImageInfo」；
 *   - 浏览器侧的 fetch 都在 BrowserView evaluate 内完成，cookie / header /
 *     原始响应 body 不走 IPC，不进主进程日志；
 *   - **evaluate 函数体序列化到 BrowserView 里执行**，因此**不能**引用模块
 *     作用域里的任何标识符；CID 读取必须**内联**在 evaluate 函数体内部，曾
 *     经引用外部 `readCidFromDocument` 会在页内 ReferenceError。
 *   - 提供 buildSuggestPoiRequest / buildSearchImageRequest / parseSuggestPoiPayload /
 *     parseSuggestPoiPlaces / parseSearchImagePayload 几个纯函数，便于单测。
 *
 * 调用入口：
 *   - src/main/operations/cover-ipc.ts 的 searchCtripLibraryCoverPlaces /
 *     searchCtripLibraryCoverImages 走本模块；不再读 DOM / 弹窗。
 */
import type {
  CtripLibraryImageCandidate,
  CtripLibraryPlaceCandidate,
  CtripLibraryPlaceSearchResult,
  CtripLibrarySearchResult,
} from "../../shared/contracts-types.js";
import type { CtripLibraryImageInfo } from "./ctrip-image-info.js";
import { fetchCtripImageInfoMap } from "./ctrip-image-info.js";
import {
  SILENT_COVER_PLACE_LOGGER,
  type CoverPlaceSearchLogger,
  type CoverPlaceSearchSessionContext,
} from "./cover-place-search-logger.js";
import { vbkSessionRequest } from "./vbk-session-request.js";
import {
  SUGGESTPOI_ENDPOINT,
  SEARCH_IMAGE_ENDPOINT,
  CTRIP_LIBRARY_BROWSER_REQUEST_TIMEOUT_MS,
  CTRIP_LIBRARY_EVALUATE_TIMEOUT_MS,
  CTRIP_LIBRARY_REFERRER,
  EMPTY_CTRIP_SESSION_CONTEXT,
  type CtripLibrarySearchBrowser,
  type CtripLibraryRequestHead,
  type SuggestPoiParsedPoi,
  type SuggestPoiPlacesResult,
  type SearchImageResponse,
  buildSuggestPoiRequest,
  buildSearchImageRequest,
  parseSuggestPoiPlaces,
  parseSearchImagePayload,
  emptyHead,
  clampPageSize,
  positiveInteger,
  failureReason,
  timeoutOrDefault,
} from "./ctrip-library-protocol.js";

export {
  SUGGESTPOI_ENDPOINT,
  SEARCH_IMAGE_ENDPOINT,
  SEARCH_IMAGE_MAX_PAGE_SIZE,
  CTRIP_LIBRARY_BROWSER_REQUEST_TIMEOUT_MS,
  CTRIP_LIBRARY_EVALUATE_TIMEOUT_MS,
  buildSuggestPoiRequest,
  buildSearchImageRequest,
  parseSuggestPoiPayload,
  parseSuggestPoiPlaces,
  parseSearchImagePayload,
} from "./ctrip-library-protocol.js";

export interface SearchCtripLibraryOptions {
  browserRequestTimeoutMs?: number;
  evaluateTimeoutMs?: number;
  /** 可选 logger：cover-ipc 注入 console.warn 桥接；测试可注入 spy / silent。 */
  logger?: CoverPlaceSearchLogger | null;
  /**
   * 是否发出 search-start 事件（默认 true）。
   * 仅 searchCtripLibraryImagesForPlace 内部使用：
   * 旧兼容 wrapper searchCtripLibraryImages 在已经走过 searchCtripLibraryPlaces
   * 之后调用阶段 B 时会传入 false，避免重复的 search-start 事件。
   */
  emitSearchStart?: boolean;
}

/** 阶段 A：keyword → suggestpoi.json → 地址 / 景点候选列表。
 *  - 业务失败 / 网络失败向上抛错（logger 已记录失败原因）；
 *  - 合法候选至少要有 poiId + poiName；其它字段（address / province / city /
 *    district）从 suggestPoi 响应里抽取，缺时为 null；
 *  - 业务 Ack 成功但无合法候选时返回空 places（不抛错），UI 走"无结果"分支。
 */
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

/** 阶段 B：已选 place { poiId, ... } → searchImage → imageIds → getImageInfo。
 *  - 阶段 A 由 UI 先行选择某个 place，传入 poiId（必填正整数）；
 *  - searchImage 失败 / imageIds 为空 / getImageInfo 抛错 全部向上传播；
 *  - logger 覆盖 image-ids-extracted / searchImage.success/failure / skip-image-info
 *    / image-info 端到端事件。
 */
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
  // （source 3）仍有可用图片。仅在首选渠道为空时回退，避免把“渠道无图”
  // 误判成“POI 无图”并永久阻断 readiness。
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

/**
 * 携程图库封面查询主入口（cover:searchCtripLibrary 旧链路 / 向后兼容 wrapper）：
 *  1. 调 suggestPoiPlaces 解析所有候选；
 *  2. 取第一个合法 POI（与旧 single-stage 行为一致）；
 *  3. 调 searchImage 拿 imageIds；
 *  4. 调 fetchCtripImageInfoMap 把 imageId 转成完整 URL / 评分 / 分辨率；
 *  5. 按搜索顺序组装 CtripLibrarySearchResult 返回；
 *  6. 任意步骤抛错向上传播（logger 已记录失败原因）。
 *
 * 新代码应**优先**走 searchCtripLibraryPlaces + searchCtripLibraryImagesForPlace
 * 两阶段，让用户在 UI 上先选地址；本 wrapper 仅为旧 IPC / 旧测试提供兼容。
 */
export async function searchCtripLibraryImages(
  browser: CtripLibrarySearchBrowser,
  keyword: string,
  options: SearchCtripLibraryOptions = {},
): Promise<CtripLibrarySearchResult> {
  const placesResult = await searchCtripLibraryPlaces(browser, keyword, options);
  if (placesResult.places.length === 0) {
    throw new Error(`suggestPoi 未找到匹配 POI：${placesResult.keyword}`);
  }
  const first = placesResult.places[0];
  return searchCtripLibraryImagesForPlace(
    browser,
    { keyword: placesResult.keyword, place: first },
    // 阶段 A 已经发了 search-start；阶段 B 在 wrapper 链路里不要再发，
    // 否则日志事件序列会出现重复的 search-start。
    { ...options, emitSearchStart: false },
  );
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
  logger: CoverPlaceSearchLogger,
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
    // 阶段 A：空 places 不抛错，让 UI 显示「无结果」分支；这里返回 detail 即可。
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

async function callSearchImage(
  browser: CtripLibrarySearchBrowser,
  poiId: number,
  options: SearchCtripLibraryOptions,
  logger: CoverPlaceSearchLogger,
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

function buildPlaceCandidateFromPoi(poi: SuggestPoiParsedPoi, index: number): CtripLibraryPlaceCandidate {
  const stableId = `poi:${poi.poiId}`;
  return {
    stableId,
    index,
    poiId: poi.poiId,
    poiName: poi.poiName,
    address: poi.address ?? null,
    province: poi.province ?? null,
    city: poi.city ?? null,
    district: poi.district ?? null,
    rawText: `poiId=${poi.poiId}`,
  };
}

function buildCandidateFromImageInfo(args: {
  imageId: number;
  index: number;
  poi: SuggestPoiParsedPoi;
  info: CtripLibraryImageInfo | undefined;
}): CtripLibraryImageCandidate {
  const { imageId, index, poi, info } = args;
  const stableId = `imageId:${imageId}`;
  if (!info) {
    // searchImage 给出了 imageId，但 getImageInfo 没拿到：仍占位返回，UI 走空提示。
    return {
      stableId,
      index,
      quality: "",
      resolution: "",
      imageId,
      poiId: poi.poiId,
      poiName: poi.poiName,
      imageResolved: false,
      rawText: `poiId=${poi.poiId}`,
    };
  }
  const thumbnailUrl = info.thumbnailUrl ?? undefined;
  const previewUrl = info.previewUrl ?? undefined;
  const originalUrl = info.originalUrl ?? undefined;
  const imageUrl = thumbnailUrl ?? previewUrl ?? originalUrl;
  const candidate: CtripLibraryImageCandidate = {
    stableId,
    index,
    quality: info.score !== null ? String(info.score) : "",
    resolution: info.resolution ?? "",
    imageId: info.imageId ?? imageId,
    poiId: info.poiId ?? poi.poiId,
    poiName: info.poiName ?? poi.poiName,
    score: info.score ?? undefined,
    fileName: info.fileName ?? undefined,
    districtName: info.districtName ?? undefined,
    countryName: info.countryName ?? undefined,
    thumbnailUrl,
    previewUrl,
    imageUrl: imageUrl ?? undefined,
    imageResolved: true,
  };
  candidate.rawText = `imageId=${imageId};poiId=${info.poiId ?? poi.poiId}`;
  return candidate;
}

// ─────────────────────────────────────────────────────────────────────────
// 工具函数：head / cookie / 解析 / 超时。
// ─────────────────────────────────────────────────────────────────────────
