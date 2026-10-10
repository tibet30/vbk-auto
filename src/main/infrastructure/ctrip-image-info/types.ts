/**
 * 携程图库图片详情契约：
 *   - 单图条目（CtripLibraryImageInfo）；
 *   - URL 变体（CtripImageUrlVariant）；
 *   - 请求头 + 请求体（CtripImageInfoRequest）；
 *   - 响应（CtripImageInfoResponse）；
 *   - 可观测日志（CtripImageInfoLogEvent）+ logger 桥接形状；
 *   - Timeout / 超时类。
 *
 * 备注：本文件不持有实现，所有内容都按"形状/契约"聚合；实现走同目录其它文件。
 */

import type { CoverPlaceSearchSessionContext } from "../cover-place-search-logger.js";

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

/** getImageInfo 请求头（对齐 VBK SOA + 真实请求）。 */
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

/** urlOptions 单项（width/height/quality/type 四元组）。 */
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

export class CtripImageInfoTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CtripImageInfoTimeoutError";
  }
}