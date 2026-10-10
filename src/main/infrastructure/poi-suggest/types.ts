/**
 * POI 候选查询的对外契约 + 模块常量：
 *   - PoiSuggestRequest：soa2/20049/suggestPoi 的请求体（固定 shape）；
 *   - PoiDistrictSortDto：district 排序锚点；
 *   - PoiSuggestDemoResult：精简 demo 结果（httpStatus / businessStatus / best）；
 *   - PoiSuggestBrowser：minimal browser contract（main / test 都用）；
 *   - PoiSuggestTimeoutOptions：超时 / 上下文选项；
 *   - PoiSuggestTimeoutError：超时错误类。
 *
 * 本文件只放"形状"，不放"实现"。
 */

import type { PoiSuggestion } from "../../../shared/contracts.js";

export interface PoiSuggestRequest {
  requestHeader: { locale: "zh-CN" };
  poiTypes: Array<{ key: number; name: string }>;
  count: 100;
  keyword: string;
  tagIds: [];
  useENameSort: "T";
  districtSortDto: PoiDistrictSortDto;
  contentType: "json";
}

export interface PoiDistrictSortDto {
  districtIds: number[];
  poiIds: number[];
}

export interface PoiSuggestDemoResult {
  httpStatus: number;
  businessStatus: string | number | boolean | null;
  poiListCount: number;
  best: PoiSuggestion | null;
}

export interface PoiSuggestBrowser {
  evaluate<T, A = unknown>(fn: (arg: A) => T | Promise<T>, arg: A): Promise<T>;
}

export interface PoiSuggestTimeoutOptions {
  /** 浏览器页内 fetch 的取消上限；默认 12 秒。 */
  browserRequestTimeoutMs?: number;
  /** BrowserView evaluate 自身悬挂时，主进程的兜底上限；默认 15 秒。 */
  evaluateTimeoutMs?: number;
  /** 自动补全 POI 时使用的产品地域上下文，用来剔除外地同名景点。 */
  destinationCity?: string;
  province?: string;
}

export class PoiSuggestTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PoiSuggestTimeoutError";
  }
}

export const SUGGEST_POI_ENDPOINT = "https://online.ctrip.com/restapi/soa2/20049/suggestPoi";
export const POI_BROWSER_REQUEST_TIMEOUT_MS = 12_000;
export const POI_EVALUATE_TIMEOUT_MS = 15_000;