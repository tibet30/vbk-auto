import {
  vbkSessionRequest,
  type VbkSessionRequestBrowser,
} from "../../../infrastructure/vbk-session-request.js";

export type TrafficLinePage = VbkSessionRequestBrowser;
export type JsonRecord = Record<string, unknown>;

export const TRAFFIC_LINE_SOA = "https://online.ctrip.com/restapi/soa2";
export const TRAFFIC_LINE_HEAD = {
  cid: "", ctok: "", cver: "1.0", lang: "01", sid: "8888", syscode: "09", auth: "", extension: [],
} as const;

export async function postTrafficLineSoa(
  page: TrafficLinePage,
  service: "15638" | "20046" | "20049" | "20698",
  method: string,
  body: JsonRecord,
  label: string,
): Promise<JsonRecord> {
  return requestWithSessionAckRetry(page, {
    endpoint: `${TRAFFIC_LINE_SOA}/${service}/${method}`,
    body: { contentType: "json", head: TRAFFIC_LINE_HEAD, ...body },
    headers: { cookieorigin: "https://vbooking.ctrip.com", "x-tt-core": "1" },
  }, label);
}

/** 20046 条款服务使用独立的 text/plain payload，不能强塞 15638 的 head。 */
export async function postTrafficLineRaw(
  page: TrafficLinePage,
  endpoint: string,
  body: JsonRecord,
  label: string,
): Promise<JsonRecord> {
  return requestWithSessionAckRetry(page, {
    endpoint,
    body,
    headers: { cookieorigin: "https://vbooking.ctrip.com", "x-tt-core": "1", "content-type": "text/plain;charset=UTF-8" },
  }, label);
}

async function requestWithSessionAckRetry(
  page: TrafficLinePage,
  request: { endpoint: string; body: JsonRecord; headers: Record<string, string> },
  label: string,
): Promise<JsonRecord> {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    let response;
    try {
      response = await vbkSessionRequest(page, {
        ...request,
        browserRequestTimeoutMs: 15_000,
        evaluateTimeoutMs: 20_000,
        errorLabel: label,
      });
    } catch (error) {
      if (!explicitSessionHttpFailure(error)) throw error;
      if (attempt === 3) {
        throw new Error(`${label}连续 3 次被会话鉴权拒绝；服务端未接受写入，可在登录态恢复后安全重试。`);
      }
      await new Promise<void>((resolve) => setTimeout(resolve, attempt * 300));
      continue;
    }
    try {
      return assertTrafficLineAck(response.payload, label);
    } catch (error) {
      // 服务端明确回复“未登录”时不会接受本次写入，可在同一
      // BrowserView 会话中有界重试。其它 Ack 错误可能已触发业务副作用，不重提。
      if (!explicitSessionFailure(response.payload)) throw error;
      if (attempt === 3) {
        throw new Error(`${label}连续 3 次返回会话未登录；服务端未接受写入，可在登录态恢复后安全重试。`);
      }
      await new Promise<void>((resolve) => setTimeout(resolve, attempt * 300));
    }
  }
  throw new Error(`${label}会话重试未完成。`);
}

function explicitSessionFailure(payload: unknown): boolean {
  const status = record(record(payload)?.ResponseStatus);
  const detail = list(status?.Errors).map((item) => text(item.Message) || text(item.ErrorCode)).join("；");
  return text(status?.Ack) !== "Success" && /当前用户未登录|用户未登录|登录态(?:已)?失效|请(?:先|重新)登录/.test(detail);
}

function explicitSessionHttpFailure(error: unknown): boolean {
  return /失败：HTTP (?:401|403)(?:\D|$)/.test(error instanceof Error ? error.message : String(error));
}

export async function getTrafficLineEditorState(page: TrafficLinePage, parentProductId: string): Promise<JsonRecord> {
  const endpoint = `https://vbooking.ctrip.com/ivbk/vendor/trafficLineEdit?productid=${encodeURIComponent(parentProductId)}&istab=1&from=vbk`;
  return getVbkInitialState(page, endpoint, "线路及交通编辑页");
}

export async function getVbkInitialState(page: TrafficLinePage, endpoint: string, label: string): Promise<JsonRecord> {
  if (!page.vbkSessionGetText) {
    throw new Error(`${label}缺少当前 BrowserView 会话适配器；未发起请求，可在登录态恢复后安全重试。`);
  }
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const response = await page.vbkSessionGetText({ endpoint, errorLabel: label });
    const { status, text: html } = response;
    if (status === 401 || status === 403) {
      if (attempt === 3) throw new Error(`${label}连续 3 次被会话鉴权拒绝；只读请求未改变平台，可安全重试。`);
      await new Promise<void>((resolve) => setTimeout(resolve, attempt * 300));
      continue;
    }
    if (status < 200 || status >= 300) throw new Error(`${label}读取失败：HTTP ${status}`);
    const state = parseInitialState(html, label);
    const location = record(state.location);
    if (state.action === "login" || text(location?.pathname) === "/login") {
      if (attempt === 3) throw new Error(`${label}连续 3 次返回登录页；只读请求未改变平台，可在重新登录后安全重试。`);
      await new Promise<void>((resolve) => setTimeout(resolve, attempt * 300));
      continue;
    }
    return state;
  }
  throw new Error(`${label}会话重试未完成。`);
}

export function assertTrafficLineAck(payload: unknown, label: string): JsonRecord {
  const root = record(payload);
  const status = record(root?.ResponseStatus);
  const ack = text(status?.Ack);
  const errors = list(status?.Errors);
  if (ack !== "Success" || errors.length) {
    const detail = errors.map((item) => {
      const code = text(item.ErrorCode) || text(item.Code);
      const message = text(item.Message);
      return [code, message].filter(Boolean).join(":");
    }).filter(Boolean).join("；");
    throw new Error(`${label}失败（Ack=${ack || "缺失"}）${detail ? `：${detail}` : ""}`);
  }
  if (!root) throw new Error(`${label}失败：响应不是对象。`);
  return root;
}

export function parseInitialState(html: string, label: string): JsonRecord {
  const marker = html.search(/window\.__INITIAL_STATE__\s*=/);
  if (marker < 0) throw new Error(`${label}缺少 window.__INITIAL_STATE__`);
  const start = html.indexOf("{", marker);
  const end = start < 0 ? -1 : findJsonObjectEnd(html, start);
  if (start < 0 || end < 0) throw new Error(`${label}的 __INITIAL_STATE__ JSON 无效`);
  const json = html.slice(start, end + 1);
  try { return record(JSON.parse(json)) ?? {}; } catch { throw new Error(`${label}的 __INITIAL_STATE__ JSON 无效`); }
}

function findJsonObjectEnd(source: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") depth += 1;
    else if (char === "}" && --depth === 0) return index;
  }
  return -1;
}

export function record(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : null;
}

export function list(value: unknown): JsonRecord[] {
  return Array.isArray(value) ? value.flatMap((item) => record(item) ? [record(item)!] : []) : [];
}

export function text(value: unknown): string {
  return typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
}

export function positiveId(value: unknown): string {
  const id = text(value);
  return /^\d+$/.test(id) && !/^0+$/.test(id) ? id : "";
}
