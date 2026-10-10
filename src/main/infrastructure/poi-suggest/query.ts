/**
 * suggestPoi 的 BrowserView evaluate fetch + 解析封装（私有）：
 *   - queryPoiSuggest：调 vbkSessionRequest → 跑一遍 suggestDistrict 本地化 →
 *     parsePoiSuggestPayload；
 *   - suggestPoiDemo：对 queryPoiSuggest 做"精简"裁剪，UI / 性能简单要求时使用。
 *
 * 与 parse.ts / match.ts 解耦：query 不直接调 match，只调 parse。
 */

import type { PoiSuggestDetailResultWithRawPayload } from "../poi-suggest-detail.js";
import { vbkSessionRequest, VbkSessionRequestTimeoutError } from "../vbk-session-request.js";
import { localizePoiListDistricts } from "../suggest-district.js";
import type {
  PoiSuggestBrowser,
  PoiSuggestDemoResult,
  PoiSuggestTimeoutOptions,
} from "./types.js";
import {
  PoiSuggestTimeoutError,
  POI_BROWSER_REQUEST_TIMEOUT_MS,
  POI_EVALUATE_TIMEOUT_MS,
  SUGGEST_POI_ENDPOINT,
} from "./types.js";
import { buildPoiSuggestRequest } from "./request.js";
import { parsePoiSuggestPayload } from "./parse.js";

function timeoutOrDefault(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && value! > 0 ? Math.floor(value!) : fallback;
}

export async function queryPoiSuggest(
  browser: PoiSuggestBrowser,
  keyword: string,
  options: PoiSuggestTimeoutOptions = {},
): Promise<PoiSuggestDetailResultWithRawPayload> {
  const request = buildPoiSuggestRequest(keyword);
  const browserRequestTimeoutMs = timeoutOrDefault(options.browserRequestTimeoutMs, POI_BROWSER_REQUEST_TIMEOUT_MS);
  const evaluateTimeoutMs = timeoutOrDefault(options.evaluateTimeoutMs, POI_EVALUATE_TIMEOUT_MS);
  let response;
  try {
    response = await vbkSessionRequest(browser, {
      endpoint: SUGGEST_POI_ENDPOINT,
      body: request,
      browserRequestTimeoutMs,
      evaluateTimeoutMs,
      errorLabel: "VBK POI 查询",
      includeCidQuery: false,
    });
  } catch (error) {
    if (error instanceof VbkSessionRequestTimeoutError) {
      throw new PoiSuggestTimeoutError(error.message);
    }
    throw error;
  }
  const payload = response.payload;
  const body = asRecord(payload);
  const data = asRecord(body?.data);
  const list = Array.isArray(body?.poiList) ? body.poiList : Array.isArray(data?.poiList) ? data.poiList : [];
  // suggestPoi 的 districtName 偶发英文；用 suggestDistrict 按 districtId 映回中文后再解析展示。
  await localizePoiListDistricts(browser, list, {
    browserRequestTimeoutMs,
    evaluateTimeoutMs,
  });
  return parsePoiSuggestPayload(keyword, payload, response.status, options);
}

export async function suggestPoiDemo(
  browser: PoiSuggestBrowser,
  keyword: string,
  options: PoiSuggestTimeoutOptions = {},
): Promise<PoiSuggestDemoResult> {
  const parsed = await queryPoiSuggest(browser, keyword, options);
  return {
    httpStatus: parsed.httpStatus,
    businessStatus: parsed.businessStatus,
    poiListCount: parsed.poiListCount,
    best: parsed.best,
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}