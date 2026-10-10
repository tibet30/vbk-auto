/**
 * 携程图库 getImageInfo 主入口（BrowserView 内 fetch + 摘要回主进程）：
 *   - fetchCtripImageInfo：构造请求 → 在 BrowserView evaluate 内 fetch →
 *     返回结构化摘要（cookie / 响应 body 全部留在 BrowserView 内）；
 *   - fetchCtripImageInfoMap：把响应按 imageId 索引为 Map，便于回填候选。
 *
 * 可观测日志（v2）：
 *   - 通过 options.logger 注入 console 桥接；不传 → no-op；
 *   - 事件：fetch-start / fetch-end / fetch-failure；
 *   - payload 始终不携带 cookie / header / token / 原始响应全文。
 */

import type { PoiSuggestBrowser } from "../poi-suggest.js";
import { EMPTY_COVER_PLACE_SEARCH_CONTEXT } from "../cover-place-search-logger.js";
import { vbkSessionRequest } from "../vbk-session-request.js";
import type {
  CtripImageInfoResponse,
  CtripImageInfoTimeoutOptions,
  CtripLibraryImageInfo,
} from "./types.js";
import { parseCtripImageInfoPayload } from "./parse.js";
import {
  GET_IMAGE_INFO_ENDPOINT,
  CTRIP_IMAGE_INFO_REFERRER,
  CTRIP_IMAGE_INFO_BROWSER_REQUEST_TIMEOUT_MS,
  CTRIP_IMAGE_INFO_EVALUATE_TIMEOUT_MS,
  buildCtripImageInfoRequest,
} from "./request.js";

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
  const unique: number[] = [];
  const seen = new Set<number>();
  for (const value of imageIds) {
    const coerced = typeof value === "number" ? value : Number(value);
    if (!Number.isInteger(coerced) || coerced <= 0) continue;
    if (seen.has(coerced)) continue;
    seen.add(coerced);
    unique.push(coerced);
  }
  if (unique.length === 0) return new Map();
  const response = await fetchCtripImageInfo(browser, unique, options);
  const map = new Map<number, CtripLibraryImageInfo>();
  for (const item of response.items) {
    if (item.imageId !== null && !map.has(item.imageId)) map.set(item.imageId, item);
  }
  return map;
}

function timeoutOrDefault(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && value! > 0 ? Math.floor(value!) : fallback;
}