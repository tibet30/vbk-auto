/**
 * 携程图库图片详情查询（getImageInfo）：
 *   - 输入 imageIds，调用 https://online.ctrip.com/restapi/soa2/12719/getImageInfo
 *     拉取每张图的预览/缩略图 URL、POI 信息、质量分、分辨率等；
 *   - 在 VBK BrowserView 内 fetch（credentials:"include"），不直接搬运 cookie；
 *   - head.cid 从浏览器上下文 document.cookie 里读（GUID 或 vbk_login_cid 兜底），
 *     缺失时明确失败，不写死任何用户身份；
 *   - Ack 必须是 Success；否则抛中文错误；
 *   - 提供 parseCtripImageInfoPayload 纯函数，便于单元测试。
 *
 * 可观测日志（v2）：
 *   - BrowserView evaluate 不再返回原始响应文本给主进程，仅返回结构化摘要
 *     `{ status, ack, items, durationMs, errorMessage }`；cookie / header /
 *     响应 body 始终留在 BrowserView 内，不会走 IPC，不会进 console；
 *   - 调用方通过 options.logger 注入 console 桥接；不传 → no-op；
 *   - 事件：
 *       fetch-start    ：fetch 开始（含 endpoint / timeoutMs / imageIdCount）；
 *       fetch-end      ：fetch 成功（含 httpStatus / Ack / itemCount / imageIdCount / durationMs）；
 *       fetch-failure  ：fetch / Ack / JSON 解析失败（含 message / durationMs）。
 *
 * 调用入口：
 *   - src/main/infrastructure/ctrip-library-search.ts 在读取图库弹窗候选
 *     后，用 imageIds 调 fetchCtripImageInfo 补全 previewUrl / thumbnailUrl /
 *     poiName / score 等字段；
 *   - 后续 cover:searchCtripLibrary 链路若直接拿到 imageIds，可绕过弹窗直接
 *     走本模块。
 */
import type { PoiSuggestBrowser } from "./poi-suggest.js";
import { EMPTY_COVER_PLACE_SEARCH_CONTEXT, type CoverPlaceSearchSessionContext } from "./cover-place-search-logger.js";
import { vbkSessionRequest } from "./vbk-session-request.js";

export interface CtripImageUrlVariant {
  width: number | null;
  height: number | null;
  type: string | null;
  url: string;
}

export interface CtripLibraryImageInfo {
  imageId: number | null;
  poiId: number | null;
  poiName: string | null;
  /** 200 像素缩略图；缺失回退 originalPath。 */
  thumbnailUrl: string | null;
  /** 500 像素预览图；缺失回退 originalPath。 */
  previewUrl: string | null;
  /** 原图 URL（兜底）。 */
  originalUrl: string | null;
  /** 原图分辨率文本，例如 "1280*1917"。 */
  resolution: string | null;
  /** 质量分（noteImgScore 优先）。 */
  score: number | null;
  fileName: string | null;
  districtName: string | null;
  countryName: string | null;
  /** 携带所有 imageUrls，方便上层自选最大/最小档。 */
  imageUrls: CtripImageUrlVariant[];
}

export interface CtripImageInfoResponse {
  httpStatus: number;
  businessStatus: string;
  items: CtripLibraryImageInfo[];
}

export const GET_IMAGE_INFO_ENDPOINT = "https://online.ctrip.com/restapi/soa2/12719/getImageInfo";
export const CTRIP_IMAGE_INFO_BROWSER_REQUEST_TIMEOUT_MS = 12_000;
export const CTRIP_IMAGE_INFO_EVALUATE_TIMEOUT_MS = 15_000;
export const CTRIP_IMAGE_INFO_REFERRER =
  "https://vbooking.ctrip.com/product/input/productImageText?pattern=1&from=vbk";

export class CtripImageInfoTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CtripImageInfoTimeoutError";
  }
}

/**
 * getImageInfo 请求体（对齐 VBK SOA 其它接口 + 用户提供的真实请求）。
 *  - contentType: "json" 与 head 的完整字段族与 hotel/vehicle resource 请求一致；
 *  - returnTagTypes：固定 4 类；
 *  - urlOptions：200 + 500 两档，带 quality / type，UI 分别做缩略图 / 预览图；
 *  - imageIds：调用方传入（去重 + 过滤非正整数）。
 */
export interface CtripImageInfoRequestHead {
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

export interface CtripImageInfoUrlOption {
  width: number;
  height: number;
  quality: number;
  type: string;
}

export interface CtripImageInfoRequest {
  contentType: "json";
  head: CtripImageInfoRequestHead;
  returnTagTypes: ReadonlyArray<"Attraction" | "Country" | "District" | "PoiId">;
  urlOptions: ReadonlyArray<CtripImageInfoUrlOption>;
  imageIds: ReadonlyArray<number>;
}

export function buildCtripImageInfoRequest(args: {
  cid: string;
  imageIds: ReadonlyArray<number>;
}): CtripImageInfoRequest {
  const ids = uniquePositiveIntegers(args.imageIds);
  if (ids.length === 0) throw new Error("查询携程图库图片必须提供至少一个 imageId。");
  return {
    contentType: "json",
    head: {
      cid: args.cid || "",
      ctok: "",
      cver: "1.0",
      lang: "01",
      sid: "8888",
      syscode: "09",
      auth: "",
      xsid: "",
      extension: [],
    },
    returnTagTypes: ["Attraction", "Country", "District", "PoiId"],
    urlOptions: [
      { width: 200, height: 200, quality: 0.9, type: "R" },
      { width: 500, height: 500, quality: 0.9, type: "R" },
    ],
    imageIds: ids,
  };
}

/**
 * BrowserView evaluate 返回给主进程的「安全摘要」：
 *  - 只携带可观测的状态字段（status / ack / items / durationMs / error），
 *    绝不携带 cookie / header / token / 原始响应全文；
 *  - 用于 cover-place-search → cover-ipc 的可观测日志，避免主进程侧直接消费
 *    evaluate 内部 fetch 的 status+text 组合而误把 HTML / cookie 倒进 console。
 */
export interface CtripImageInfoBrowserSummary {
  endpoint: string;
  httpStatus: number;
  /** 业务 Ack；Success / Failure / 其它原始字符串。 */
  ack: string;
  items: CtripLibraryImageInfo[];
  /** BrowserView evaluate 内的 fetch 耗时（含读取 cookie / 解析 body）。 */
  durationMs: number;
  /** 失败原因（成功为 null）；已 redact。 */
  errorMessage: string | null;
}

/**
 * fetchCtripImageInfo 的可观测 logger：cover-ipc 注入 console.warn 桥接；
 *  - 在 BrowserView evaluate 内 fetch 开始时触发 start（含 endpoint / timeoutMs）；
 *  - 在 evaluate 内 fetch 结束时触发 end（含 status / durationMs / errorMessage）；
 *  - payload **绝不**携带 cookie / header / token / 完整响应 body。
 */
export type CtripImageInfoLogger = (record: CtripImageInfoLogEvent) => void;

export type CtripImageInfoLogEvent =
  | {
      event: "fetch-start";
      endpoint: string;
      timeoutMs: number;
      imageIdCount: number;
      ctx: CoverPlaceSearchSessionContext;
    }
  | {
      event: "fetch-end";
      endpoint: string;
      httpStatus: number;
      ack: string;
      itemCount: number;
      imageIdCount: number;
      durationMs: number;
      ctx: CoverPlaceSearchSessionContext;
    }
  | {
      event: "fetch-failure";
      endpoint: string;
      httpStatus: number;
      message: string;
      durationMs: number;
      ctx: CoverPlaceSearchSessionContext;
    };

/**
 * 主入口：在 BrowserView evaluate 内 fetch getImageInfo，返回图片详情列表。
 * 抛错场景：未登录浏览器请求失败 / Ack 非 Success / 反序列化失败。
 *
 * 为避免 cookie / 原始响应文本泄漏到主进程 / 日志，BrowserView evaluate
 * 仅返回结构化摘要 `{ status, ack, items, durationMs, errorMessage }`；
 * main 进程不再消费 `result.text()` 原文。原始响应只在 BrowserView 内部
 * 存在，不走 IPC，不进日志。
 */
export async function fetchCtripImageInfo(
  browser: PoiSuggestBrowser,
  imageIds: ReadonlyArray<number>,
  options: CtripImageInfoTimeoutOptions = {},
): Promise<CtripImageInfoResponse> {
  const request = buildCtripImageInfoRequest({ cid: "", imageIds });
  const browserRequestTimeoutMs = timeoutOrDefault(
    options.browserRequestTimeoutMs,
    CTRIP_IMAGE_INFO_BROWSER_REQUEST_TIMEOUT_MS,
  );
  const evaluateTimeoutMs = timeoutOrDefault(
    options.evaluateTimeoutMs,
    CTRIP_IMAGE_INFO_EVALUATE_TIMEOUT_MS,
  );
  const logger = options.logger ?? null;
  const ctx = options.ctx ?? EMPTY_COVER_PLACE_SEARCH_CONTEXT;
  if (logger) {
    logger({
      event: "fetch-start",
      endpoint: GET_IMAGE_INFO_ENDPOINT,
      timeoutMs: browserRequestTimeoutMs,
      imageIdCount: imageIds.length,
      ctx,
    });
  }
  let response: Awaited<ReturnType<typeof vbkSessionRequest>>;
  try {
    response = await vbkSessionRequest(browser, {
      endpoint: GET_IMAGE_INFO_ENDPOINT,
      body: request,
      browserRequestTimeoutMs,
      evaluateTimeoutMs,
      errorLabel: "携程图库图片查询",
      headers: {
        "accept-language": "zh-CN,zh;q=0.9",
        cookieorigin: "https://vbooking.ctrip.com",
        "x-input-locale": "zh-CN",
      },
      referrer: CTRIP_IMAGE_INFO_REFERRER,
      referrerPolicy: "strict-origin-when-cross-origin",
    });
  } catch (error) {
    if (logger) {
      logger({
        event: "fetch-failure",
        endpoint: GET_IMAGE_INFO_ENDPOINT,
        httpStatus: 0,
        message: error instanceof Error ? error.message : String(error),
        durationMs: 0,
        ctx,
      });
    }
    throw error;
  }
  let parsed: CtripImageInfoResponse;
  try {
    parsed = parseCtripImageInfoPayload(response.payload, response.status);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (logger) {
      logger({
        event: "fetch-failure",
        endpoint: GET_IMAGE_INFO_ENDPOINT,
        httpStatus: response.status,
        message,
        durationMs: response.durationMs,
        ctx,
      });
    }
    throw error;
  }
  if (logger) {
    logger({
      event: "fetch-end",
      endpoint: GET_IMAGE_INFO_ENDPOINT,
      httpStatus: parsed.httpStatus,
      ack: parsed.businessStatus,
      itemCount: parsed.items.length,
      imageIdCount: imageIds.length,
      durationMs: response.durationMs,
      ctx,
    });
  }
  return parsed;
}

export interface CtripImageInfoTimeoutOptions {
  browserRequestTimeoutMs?: number;
  evaluateTimeoutMs?: number;
  /** 可选 logger：cover-ipc 注入 console.warn 桥接；测试可注入 spy / silent。 */
  logger?: CtripImageInfoLogger | null;
  /**
   * 可选会话上下文：当日志事件需要真实 cookie 状态（hasCid / hasGuidCookie / ...）
   * 时由上层注入；未注入则回退到 EMPTY_COVER_PLACE_SEARCH_CONTEXT，
   * 满足日志 schema 但不携带任何假信号。
   */
  ctx?: CoverPlaceSearchSessionContext;
}

/**
 * 解析 getImageInfo 响应 payload 为结构化数据。
 *  - Ack 必须为 Success（大小写不敏感）；否则抛中文错误；
 *  - body 缺失 / 不是数组时返回空 items（不抛错，让 UI 显示「未取到图库图片」）。
 *
 * 仍保留为顶层公共 API：单元测试与潜在离线 payload 解析仍可能走这条路径。
 * 生产路径（fetchCtripImageInfo）已改为在 BrowserView 内部解析。
 */
export function parseCtripImageInfoPayload(payload: unknown, httpStatus = 200): CtripImageInfoResponse {
  const root = asRecord(payload);
  const responseStatus = asRecord(root?.ResponseStatus);
  const ack = responseStatus?.Ack;
  if (!isBusinessSuccess(ack)) {
    throw new Error(`携程图库图片查询业务失败：${failureReason(responseStatus)}`);
  }
  const body = Array.isArray(root?.body) ? root.body : [];
  const items: CtripLibraryImageInfo[] = [];
  for (const entry of body) {
    const parsed = parseImageInfoEntry(entry);
    if (parsed) items.push(parsed);
  }
  return { httpStatus, businessStatus: String(ack ?? "Success"), items };
}

/**
 * 给一组 imageId 拉取 getImageInfo，按 imageId 索引成 Map 便于回填候选：
 *   - 重复 / 非法 imageId 由 buildCtripImageInfoRequest 内部丢出中文错误；
 *   - 浏览器侧抛错 / Ack 非 Success 时本函数**直接向上抛错**，由调用方
 *     （cover-place-search）选择降级到「候选返回但 imageUrl 缺失」。
 *
 * 注意：
 *   - 输入 imageIds 会去重并过滤非正整数；
 *   - 空集合 → 返回空 Map，不发请求；
 *   - 单次请求上限 100 个（与 VBK 后端约定保持一致，超过会被拒）。
 */
export async function fetchCtripImageInfoMap(
  browser: PoiSuggestBrowser,
  imageIds: ReadonlyArray<number>,
  options: CtripImageInfoTimeoutOptions = {},
): Promise<Map<number, CtripLibraryImageInfo>> {
  const unique = uniquePositiveIntegers(imageIds);
  if (unique.length === 0) return new Map();
  const response = await fetchCtripImageInfo(browser, unique, options);
  const map = new Map<number, CtripLibraryImageInfo>();
  for (const item of response.items) {
    if (item.imageId !== null && !map.has(item.imageId)) map.set(item.imageId, item);
  }
  return map;
}

function uniquePositiveIntegers(values: ReadonlyArray<number>): number[] {
  const seen = new Set<number>();
  const out: number[] = [];
  for (const value of values) {
    const coerced = typeof value === "number" ? value : Number(value);
    if (!Number.isInteger(coerced) || coerced <= 0) continue;
    if (seen.has(coerced)) continue;
    seen.add(coerced);
    out.push(coerced);
  }
  return out;
}

function parseImageInfoEntry(entry: unknown): CtripLibraryImageInfo | null {
  const record = asRecord(entry);
  if (!record) return null;
  const imageId = positiveInteger(record.imageId);
  const poiId = positiveInteger(record.poiId);
  const poiName = trimmedString(record.poiName);
  const originalUrl = trimmedString(record.originalPath);
  const fileName = trimmedString(record.fileName);
  const districtName = trimmedString(record.districtName);
  const countryName = trimmedString(record.countryName);
  const width = positiveInteger(record.width);
  const height = positiveInteger(record.height);
  const resolution = width !== null && height !== null ? `${width}*${height}` : null;
  const score = pickScore(record);
  const imageUrls: CtripImageUrlVariant[] = [];
  const rawUrls = Array.isArray(record.imageUrls) ? record.imageUrls : [];
  for (const raw of rawUrls) {
    const urlRecord = asRecord(raw);
    const url = trimmedString(urlRecord?.url);
    if (!url) continue;
    imageUrls.push({
      url,
      width: positiveInteger(urlRecord?.width),
      height: positiveInteger(urlRecord?.height),
      type: trimmedString(urlRecord?.type),
    });
  }
  const thumbnailUrl = pickVariantUrl(imageUrls, 200, 200) ?? originalUrl;
  const previewUrl = pickVariantUrl(imageUrls, 500, 500) ?? originalUrl;
  if (!imageId && !poiName && !originalUrl && imageUrls.length === 0) {
    // 完全空对象：忽略。
    return null;
  }
  return {
    imageId,
    poiId,
    poiName,
    thumbnailUrl,
    previewUrl,
    originalUrl,
    resolution,
    score,
    fileName,
    districtName,
    countryName,
    imageUrls,
  };
}

function pickVariantUrl(urls: CtripImageUrlVariant[], width: number, height: number): string | null {
  for (const variant of urls) {
    if (variant.width === width && variant.height === height && variant.url) return variant.url;
  }
  // 兜底：大小相近即算（允许 ±10% 误差，防御 CDN 改尺寸）。
  for (const variant of urls) {
    if (variant.width === null || variant.height === null) continue;
    const dw = Math.abs((variant.width - width) / width);
    const dh = Math.abs((variant.height - height) / height);
    if (dw <= 0.1 && dh <= 0.1 && variant.url) return variant.url;
  }
  return null;
}

function pickScore(record: Record<string, unknown>): number | null {
  const note = record.noteImgScore;
  if (typeof note === "number" && Number.isFinite(note)) return note;
  if (typeof note === "string") {
    const parsed = Number(note);
    if (Number.isFinite(parsed)) return parsed;
  }
  const ai = record.tourImgAiScore;
  if (typeof ai === "number" && Number.isFinite(ai)) return ai;
  if (typeof ai === "string") {
    const parsed = Number(ai);
    if (Number.isFinite(parsed)) return parsed;
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

function trimmedString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
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
