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
import type { PoiSuggestBrowser } from "./poi-suggest.js";
import { logWarn } from "../../shared/log-timestamp.js";
import type {
  CtripLibraryImageCandidate,
  CtripLibraryPlaceCandidate,
  CtripLibraryPlaceSearchResult,
  CtripLibrarySearchResult,
} from "../../shared/contracts-types.js";
import type { CtripLibraryImageInfo } from "./ctrip-image-info.js";
import { fetchCtripImageInfoMap } from "./ctrip-image-info.js";
import {
  EMPTY_COVER_PLACE_SEARCH_CONTEXT,
  SILENT_COVER_PLACE_LOGGER,
  type CoverPlaceSearchSessionContext,
  type CoverPlaceSearchLogger,
} from "./cover-place-search-logger.js";
import { vbkSessionRequest } from "./vbk-session-request.js";

/** suggestpoi.json 接口地址（VBK 图库关键词 → POI ID）。 */
export const SUGGESTPOI_ENDPOINT =
  "https://online.ctrip.com/restapi/soa2/15638/suggestpoi.json";

/**searchImage 接口地址（POI ID → imageId 列表）。 */
export const SEARCH_IMAGE_ENDPOINT =
  "https://online.ctrip.com/restapi/soa2/12719/searchImage";

/** 浏览器侧 fetch 默认超时（毫秒）。 */
export const CTRIP_LIBRARY_BROWSER_REQUEST_TIMEOUT_MS = 12_000;
/** BrowserView evaluate 自身悬挂时主进程的兜底超时（毫秒）。 */
export const CTRIP_LIBRARY_EVALUATE_TIMEOUT_MS = 15_000;
/** searchImage 单页拉取上限；超出会被后端拒，本地先裁剪。 */
export const SEARCH_IMAGE_MAX_PAGE_SIZE = 50;
export const CTRIP_LIBRARY_REFERRER =
  "https://vbooking.ctrip.com/product/input/productImageText?pattern=1&from=vbk";

export interface CtripLibrarySearchBrowser
  extends Pick<PoiSuggestBrowser, "evaluate"> {}

/** 同 VBK SOA 其它接口的 head 字段族：cid 留空字符串，由 evaluate 内联读取 cookie 注入。 */
export interface CtripLibraryRequestHead {
  cid: string;
  ctok: string;
  cver: string;
  lang: string;
  sid: string;
  syscode: string;
  auth: string;
  xsid: string;
  extension: unknown[];
}

export interface SuggestPoiRequest {
  contentType: "json";
  head: CtripLibraryRequestHead;
  keyword: string;
  orderType: string;
}

export interface SearchImageRequest {
  contentType: "json";
  head: CtripLibraryRequestHead;
  tags: ReadonlyArray<{
    tagType: "District" | "PoiId" | "Country";
    tagValue: string;
  }>;
  sources: ReadonlyArray<number>;
  urlOptions: ReadonlyArray<{
    width: number;
    height: number;
    quality: number;
    type: string;
  }>;
  imageClass: string;
  pageIndex: number;
  pageSize: number;
  auditStatuses: ReadonlyArray<number>;
  excludeGif: boolean;
}

export interface SuggestPoiParsedPoi {
  /** 候选 POI ID（>0 的整数）。 */
  poiId: number;
  /** 候选 POI 名称；用于上层在 UI 显示「匹配到的景点」/ 写入 cover.poiName。 */
  poiName: string;
  /** 可选：完整地址文本。 */
  address?: string | null;
  province?: string | null;
  city?: string | null;
  district?: string | null;
}

export interface SuggestPoiResponse {
  httpStatus: number;
  businessStatus: string;
  poi: SuggestPoiParsedPoi | null;
}

/** suggestPoi 完整解析结果：阶段 A 把所有合法候选都返回给 UI 选地址。 */
export interface SuggestPoiPlacesResult {
  httpStatus: number;
  businessStatus: string;
  places: SuggestPoiParsedPoi[];
}

export interface SearchImageParsedItem {
  imageId: number;
}

export interface SearchImageResponse {
  httpStatus: number;
  businessStatus: string;
  imageIds: number[];
}

/** 纯函数：构造 suggestpoi.json 请求体，keyword 留空时抛错。 */
export function buildSuggestPoiRequest(keyword: string): SuggestPoiRequest {
  const trimmed = keyword.trim();
  if (!trimmed) throw new Error("查询携程图库必须提供景点关键词。");
  return {
    contentType: "json",
    head: emptyHead(),
    keyword: trimmed,
    orderType: "",
  };
}

/** 纯函数：构造 searchImage 请求体；poiId 必须为正整数。
 *  payload 完全按用户提供的真实请求体固化：District / PoiId / Country 三个 tag
 *  （District / Country 留空）；sources [1, 9]；urlOptions 200 / 500 两档
 *  R 类型；imageClass TourProduct；pageIndex 1；pageSize 默认 20；
 *  auditStatuses [4]；excludeGif true。 */
export function buildSearchImageRequest(args: { poiId: number; pageSize?: number }): SearchImageRequest {
  if (!Number.isInteger(args.poiId) || args.poiId <= 0) {
    throw new Error("searchImage 必须传入正整数 poiId。");
  }
  const pageSize = clampPageSize(args.pageSize ?? 20);
  return {
    contentType: "json",
    head: emptyHead(),
    tags: [
      { tagType: "District", tagValue: "" },
      { tagType: "PoiId", tagValue: String(args.poiId) },
      { tagType: "Country", tagValue: "" },
    ],
    sources: [1, 9],
    urlOptions: [
      { width: 200, height: 200, quality: 0.9, type: "R" },
      { width: 500, height: 500, quality: 0.9, type: "R" },
    ],
    imageClass: "TourProduct",
    pageIndex: 1,
    pageSize,
    auditStatuses: [4],
    excludeGif: true,
  };
}

/** 解析 suggestpoi.json 响应：取第一个具备 poiId + poiName 的候选。
 *  - 仅供旧 single-stage 兼容链路使用；新两阶段链路请用 parseSuggestPoiPlaces。 */
export function parseSuggestPoiPayload(payload: unknown, httpStatus = 200): SuggestPoiResponse {
  const root = asRecord(payload);
  const responseStatus = asRecord(root?.ResponseStatus);
  const ack = responseStatus?.Ack;
  if (!isBusinessSuccess(ack)) {
    throw new Error(`suggestPoi 业务失败：${failureReason(responseStatus)}`);
  }
  // 兼容 suggestpoi 的历史与当前响应形态。
  const list = pickPoiList(root);
  for (const entry of list) {
    const poi = asRecord(entry);
    if (!poi) continue;
    // 旧 single-stage 兼容：返回最小 poi（仅 poiId + poiName），不携带 address /
    // province / city / district 等可选字段；这些字段由 parseSuggestPoiPlaces
    // 单独承担，避免破坏测试断言与已有契约。
    const parsed = parsePoiFromEntry(poi);
    if (!parsed) continue;
    return {
      httpStatus,
      businessStatus: String(ack ?? "Success"),
      poi: { poiId: parsed.poiId, poiName: parsed.poiName },
    };
  }
  return { httpStatus, businessStatus: String(ack ?? "Success"), poi: null };
}

/**
 * 解析 suggestpoi.json 响应为「地址 / 景点候选列表」：
 *  - Ack 非 Success 直接抛错；
 *  - body / poiList / poiDtos / data.* 等多种形态都尝试；
 *  - 每条 entry 至少需要 poiId + poiName 才算合法；缺任一字段即跳过；
 *  - 可选 address / province / city / district 等字段按字符串 trim 抽取，
 *    缺或非字符串 → null；
 *  - 返回所有合法候选；空列表不算错，UI 走"无结果"分支。
 *  - 按 suggestPoi 原始顺序排列；相同 poiId 仅保留首个（dedup by poiId）。
 */
export function parseSuggestPoiPlaces(payload: unknown, httpStatus = 200): SuggestPoiPlacesResult {
  const root = asRecord(payload);
  const responseStatus = asRecord(root?.ResponseStatus);
  const ack = responseStatus?.Ack;
  if (!isBusinessSuccess(ack)) {
    throw new Error(`suggestPoi 业务失败：${failureReason(responseStatus)}`);
  }
  const list = pickPoiList(root);
  const places: SuggestPoiParsedPoi[] = [];
  const seen = new Set<number>();
  for (const entry of list) {
    const poi = asRecord(entry);
    if (!poi) continue;
    const parsed = parsePoiFromEntry(poi);
    if (!parsed) continue;
    if (seen.has(parsed.poiId)) continue;
    seen.add(parsed.poiId);
    places.push(parsed);
  }
  return { httpStatus, businessStatus: String(ack ?? "Success"), places };
}

/**
 * 解析 searchImage 响应，提取 imageId 列表：
 *   - body / imageIds / images / data.imageIds / data.images 等多种形态都尝试；
 *   - 每条记录用 imageId / id / picId / pic_id 等字段识别正整数。
 *   - Ack 非 Success 直接抛错；body 为空 → 返回空数组（不抛错，UI 走"无候选"分支）。
 */
export function parseSearchImagePayload(payload: unknown, httpStatus = 200): SearchImageResponse {
  const root = asRecord(payload);
  const responseStatus = asRecord(root?.ResponseStatus);
  const ack = responseStatus?.Ack;
  if (!isBusinessSuccess(ack)) {
    throw new Error(`searchImage 业务失败：${failureReason(responseStatus)}`);
  }
  const list = pickImageList(root);
  const seen = new Set<number>();
  const imageIds: number[] = [];
  for (const entry of list) {
    const id = readImageId(entry);
    if (id === null || seen.has(id)) continue;
    seen.add(id);
    imageIds.push(id);
  }
  return {
    httpStatus,
    businessStatus: String(ack ?? "Success"),
    imageIds,
  };
}

/**
 * 把 suggestPoi 单条 entry 解析为带可选字段的 POI。
 *  - 必填：poiId 正整数 + 名称非空（poiName 优先，name 兜底）；
 *  - 选填：address / province / city / district / areaName 等常见 key；
 *  - 解析失败（缺必填）返回 null，由调用方决定是否丢弃；
 *  - 与 parseSuggestPoiPayload / parseSuggestPoiPlaces 共享字段名归一。
 */
export function parsePoiFromEntry(poi: Record<string, unknown>): SuggestPoiParsedPoi | null {
  const poiId = positiveInteger(poi.poiId);
  const rawName = optionalString(poi.poiName) ?? optionalString(poi.name) ?? "";
  if (poiId === null || !rawName) return null;
  return {
    poiId,
    poiName: rawName,
    address: optionalString(poi.address ?? poi.addr),
    province: optionalString(poi.provinceName ?? poi.province ?? poi.province_name),
    city: optionalString(poi.cityName ?? poi.city ?? poi.city_name),
    district: optionalString(poi.districtName ?? poi.district ?? poi.district_name ?? poi.areaName),
  };
}

function optionalString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

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
  const searchImage = await callSearchImage(browser, placePoiId, options, logger);

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
): Promise<SearchImageResponse> {
  const request = buildSearchImageRequest({ poiId });
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

function emptyHead(): CtripLibraryRequestHead {
  return {
    cid: "",
    ctok: "",
    cver: "1.0",
    lang: "01",
    sid: "8888",
    syscode: "09",
    auth: "",
    xsid: "",
    extension: [],
  };
}

const EMPTY_CTRIP_SESSION_CONTEXT: CoverPlaceSearchSessionContext = EMPTY_COVER_PLACE_SEARCH_CONTEXT;

function clampPageSize(value: number): number {
  if (!Number.isInteger(value) || value <= 0) return 20;
  return Math.min(value, SEARCH_IMAGE_MAX_PAGE_SIZE);
}

function pickPoiList(root: Record<string, unknown> | null): unknown[] {
  if (!root) return [];
  if (Array.isArray(root.body)) return root.body;
  if (Array.isArray(root.poiList)) return root.poiList;
  if (Array.isArray(root.poiDtos)) return root.poiDtos;
  const data = asRecord(root.data);
  if (data && Array.isArray(data.poiList)) return data.poiList;
  if (data && Array.isArray(data.poiDtos)) return data.poiDtos;
  if (data && Array.isArray(data.body)) return data.body;
  return [];
}

function pickImageList(root: Record<string, unknown> | null): unknown[] {
  if (!root) return [];
  if (Array.isArray(root.imageIds)) return root.imageIds;
  if (Array.isArray(root.imageList)) return root.imageList;
  if (Array.isArray(root.images)) return root.images;
  if (Array.isArray(root.body)) return root.body;
  const data = asRecord(root.data);
  if (!data) return [];
  if (Array.isArray(data.imageIds)) return data.imageIds;
  if (Array.isArray(data.imageList)) return data.imageList;
  if (Array.isArray(data.images)) return data.images;
  if (Array.isArray(data.body)) return data.body;
  return [];
}

function readImageId(entry: unknown): number | null {
  const record = asRecord(entry);
  if (!record) {
    if (typeof entry === "number") return positiveInteger(entry);
    if (typeof entry === "string") return positiveInteger(entry);
    return null;
  }
  const id = positiveInteger(record.imageId)
    ?? positiveInteger(record.id)
    ?? positiveInteger(record.picId)
    ?? positiveInteger(record.pic_id)
    ?? positiveInteger(record.imageID);
  if (id !== null) return id;
  // 兜底：可能是 { image: { imageId: ... } }
  const nested = asRecord(record.image);
  if (nested) {
    return positiveInteger(nested.imageId)
      ?? positiveInteger(nested.id)
      ?? positiveInteger(nested.picId);
  }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function isBusinessSuccess(ack: unknown): boolean {
  return ack === "Success" || ack === "SUCCESS" || ack === true || ack === "true";
}

function positiveInteger(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isInteger(parsed) && parsed > 0) return parsed;
  }
  return null;
}

function failureReason(status: Record<string, unknown> | null): string {
  const errors = Array.isArray(status?.Errors) ? status?.Errors : [];
  const first = asRecord(errors[0]);
  const reason = first?.Message ?? first?.message ?? first?.Code ?? status?.Ack ?? "ResponseStatus 未确认成功";
  return String(reason).replace(/[\r\n\t]/g, " ").slice(0, 300);
}

function timeoutOrDefault(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && value! > 0 ? Math.floor(value!) : fallback;
}
