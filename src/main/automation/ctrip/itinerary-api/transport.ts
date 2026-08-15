/**
 * itinerary-api/transport.ts：
 *   - soa2 端点常量（GET_TOUR_INFO_LIST / GET_TOUR_DAILY / CHECK / CALC / SAVE_*）；
 *   - 通用请求头（SOHEAD）；
 *   - 通用 postSoa 包装：负责 Ack=Success 校验、错误信息归一化；
 *   - ApiPage / ItineraryApiResult 类型。
 *
 * 所有 soa2 调用都走 postSoa，便于：
 *   - 统一注入 "x-tt-core" 头；
 *   - 统一捕获 Ack=Failure 抛错；
 *   - 测试时只替换 postSoa 或 page.evaluate 一处即可拦截全部 6 个 endpoint。
 */

import { vbkSessionRequest } from "../../../infrastructure/vbk-session-request.js";

export const GET_TOUR_INFO_LIST_URL = "https://online.ctrip.com/restapi/soa2/15638/getProductTourInfoList";
export const GET_TOUR_DAILY_URL = "https://online.ctrip.com/restapi/soa2/20049/getTourDailyDetail.json";
export const GET_DAILY_TEMPLATE_URL = "https://online.ctrip.com/restapi/soa2/20049/getDailyTemplateDetail";
export const CHECK_TOUR_DAILY_URL = "https://online.ctrip.com/restapi/soa2/15638/checkTourDaily";
export const CALC_TOUR_SCORE_URL = "https://online.ctrip.com/restapi/soa2/20049/calculateTourInfoScore";
export const SAVE_TOUR_DAILY_URL = "https://online.ctrip.com/restapi/soa2/20049/saveTourDailyDetail.json";
export const SAVE_TOUR_INFO_URL = "https://online.ctrip.com/restapi/soa2/15638/saveProductTourInfo";

export const SOHEAD = {
  cid: "",
  ctok: "",
  cver: "1.0",
  lang: "01",
  sid: "8888",
  syscode: "09",
  auth: "",
  extension: [],
} as const;

export interface ApiPage {
  evaluate<T, A = unknown>(fn: (arg: A) => T | Promise<T>, arg: A): Promise<T>;
}

export interface ItineraryApiResult {
  productId: string | number;
  tourInfoId: number | string;
  auditTourInfoId: number | string;
  days: number;
  savedSpots: number;
  savedMeals: number;
  savedHotels: number;
  pickupAirport: string;
  pickupTrain: string;
  dropoffAirport: string;
  dropoffTrain: string;
}

export type AckKind = "Success" | "Failure" | "Unknown";

export function statusAck(payload: unknown): AckKind {
  const ack = String((payload as { ResponseStatus?: { Ack?: string } })?.ResponseStatus?.Ack ?? "");
  if (ack === "Success") return "Success";
  if (ack === "Failure") return "Failure";
  return "Unknown";
}

export function describeAckError(payload: unknown): string {
  const status = (payload as { ResponseStatus?: { Errors?: Array<{ Message?: unknown; message?: unknown }> } })?.ResponseStatus;
  if (!status) return "ResponseStatus 缺失";
  if (Array.isArray(status.Errors) && status.Errors.length) {
    return status.Errors.map((e) => e?.Message || e?.message || String(e)).join(", ");
  }
  return JSON.stringify(status).slice(0, 200);
}

export interface PostSoaOptions {
  headers?: Record<string, string>;
  browserTimeoutMs?: number;
  evaluateTimeoutMs?: number;
}

/**
 * 通用 postSoa：调 vbkSessionRequest，按 Ack 决定抛错 / 返回 payload。
 *  - Ack=Success → 返回 { payload }；
 *  - Ack=Failure / Unknown → 抛中文业务错误，含 ack 状态 + 错误详情。
 */
export async function postSoa<TBody extends Record<string, unknown>>(
  page: ApiPage,
  endpoint: string,
  body: TBody,
  label: string,
  options: PostSoaOptions = {},
): Promise<{ payload: Record<string, unknown> }> {
  const response = await vbkSessionRequest(page, {
    endpoint,
    browserRequestTimeoutMs: options.browserTimeoutMs ?? 15_000,
    evaluateTimeoutMs: options.evaluateTimeoutMs ?? 20_000,
    errorLabel: label,
    body,
    headers: { "x-tt-core": "1", ...(options.headers ?? {}) },
  });
  const ack = statusAck(response.payload);
  if (ack !== "Success") {
    throw new Error(`${label}失败（Ack=${ack}）：${describeAckError(response.payload)}`);
  }
  return { payload: response.payload as Record<string, unknown> };
}
