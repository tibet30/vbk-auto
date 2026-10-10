/**
 * vbk-session-request 主流程（barrel）：
 *   - nativeOnly：直接走 Node 端 vbkSessionFetch（要求会话 cookie jar 已在 Node 端）；
 *   - 默认路径：在 BrowserView 里 evaluate，extract cookies + 注入反作弊头（x-ctx-ubt-vid / -sid），
 *     fetch 之后做：(i) 18 位行程 ID 转字符串（防 Number.MAX_SAFE_INTEGER 静默改写末位），
 *     (ii) 统计 Ack + poiDtos / body / poiList 条目数作为会话上下文 ctx；
 *   - evaluate 失败时如发现"页面被销毁/CORS/上下文消失"，自动降级到 vbkSessionFetch。
 *
 * 子文件分工：
 *   - types.ts：所有 interface + 常量（DEFAULT_VBK_SOA_HEADERS / EMPTY_VBK_SESSION_CONTEXT）；
 *   - timeout.ts：VbkSessionRequestTimeoutError + rejectAfter + timeoutOrDefault；
 *   - headers.ts：requestHeaders 合并。
 */

import { requestHeaders } from "./vbk-session-request/headers.js";
import { rejectAfter, timeoutOrDefault } from "./vbk-session-request/timeout.js";
import type {
  VbkReferrerPolicy,
  VbkSessionNativeRequest,
  VbkSessionRequestBrowser,
  VbkSessionRequestOptions,
  VbkSessionRequestResult,
} from "./vbk-session-request/types.js";

export {
  VbkSessionRequestTimeoutError,
  rejectAfter,
  timeoutOrDefault,
} from "./vbk-session-request/timeout.js";
export { requestHeaders } from "./vbk-session-request/headers.js";
export {
  DEFAULT_VBK_SOA_HEADERS,
  EMPTY_VBK_SESSION_CONTEXT,
  type VbkReferrerPolicy,
  type VbkSessionContext,
  type VbkSessionNativeRequest,
  type VbkSessionNativeResult,
  type VbkSessionNativeTextRequest,
  type VbkSessionNativeTextResult,
  type VbkSessionRequestBrowser,
  type VbkSessionRequestOptions,
  type VbkSessionRequestResult,
} from "./vbk-session-request/types.js";

const EVALUATE_RETRY_NETWORK_PATTERN = /Failed to fetch|NetworkError|CORS|Execution context was destroyed|Cannot find context with specified id|Target page, context or browser has been closed/i;

export async function vbkSessionRequest<TBody extends object>(
  browser: VbkSessionRequestBrowser,
  options: VbkSessionRequestOptions<TBody>,
): Promise<VbkSessionRequestResult> {
  const browserRequestTimeoutMs = timeoutOrDefault(options.browserRequestTimeoutMs, 12_000);
  const evaluateTimeoutMs = timeoutOrDefault(options.evaluateTimeoutMs, 15_000);
  if (browser.nativeOnly) {
    if (!browser.vbkSessionFetch) throw new Error(`${options.errorLabel}缺少账号会话请求客户端`);
    const result = await rejectAfter(browser.vbkSessionFetch({
      endpoint: options.endpoint, body: options.body, errorLabel: options.errorLabel,
      headers: requestHeaders(options.headers),
      referrer: options.referrer, referrerPolicy: options.referrerPolicy,
      businessContext: options.businessContext,
      includeCidQuery: options.includeCidQuery !== false,
      requireReadableCid: options.requireReadableCid === true, timeoutMs: browserRequestTimeoutMs,
    }), evaluateTimeoutMs, `${options.errorLabel}会话请求超时（${evaluateTimeoutMs}ms）`);
    if (result.status < 200 || result.status >= 300) throw new Error(`${options.errorLabel}失败：HTTP ${result.status}`);
    return result;
  }
  const evaluation = browser.evaluate(async ({
    body,
    endpoint,
    errorLabel,
    headers,
    includeCidQuery,
    requireReadableCid,
    referrer,
    referrerPolicy,
    timeoutMs,
  }: {
    body: TBody;
    endpoint: string;
    errorLabel: string;
    headers: Record<string, string>;
    includeCidQuery: boolean;
    requireReadableCid: boolean;
    referrer?: string;
    referrerPolicy?: VbkReferrerPolicy;
    timeoutMs: number;
  }) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const startedAt = Date.now();
    try {
      const rawCookie = (typeof document !== "undefined" && document.cookie) || "";
      let cid = "";
      let ubtVidValue = "";
      const cookieNames: string[] = [];
      let hasGuidCookie = false;
      let hasVbkLoginCidCookie = false;
      let hasUbtVidCookie = false;
      let hasVbkTicketCookie = false;
      let hasBticketCookie = false;
      let hasJsSessionIdCookie = false;
      let hasBusinessIdCookie = false;
      let hasBfaCookie = false;
      for (const entry of rawCookie.split(/;\s*/)) {
        const eq = entry.indexOf("=");
        if (eq <= 0) continue;
        const name = entry.slice(0, eq).trim();
        const value = entry.slice(eq + 1).trim();
        if (!name) continue;
        cookieNames.push(name);
        switch (name) {
          case "GUID":
          case "guid":
            hasGuidCookie = true;
            if (value) cid = decodeURIComponent(value);
            break;
          case "vbk_login_cid":
          case "VBK_LOGIN_CID":
            hasVbkLoginCidCookie = true;
            if (!cid && value) cid = decodeURIComponent(value);
            break;
          case "UBT_VID":
            hasUbtVidCookie = true;
            if (value) ubtVidValue = decodeURIComponent(value);
            break;
          case "vbkticket":
            hasVbkTicketCookie = true;
            break;
          case "bticket":
            hasBticketCookie = true;
            break;
          case "JSESSIONID":
            hasJsSessionIdCookie = true;
            break;
          case "vbk-menu-business-id":
            hasBusinessIdCookie = true;
            break;
          default:
            if (name === "_bfa") hasBfaCookie = true;
            break;
        }
      }
      const ctx: import("./vbk-session-request/types.js").VbkSessionContext = {
        hasCid: Boolean(cid),
        cookieNameCount: cookieNames.length,
        hasGuidCookie,
        hasVbkLoginCidCookie,
        hasUbtVidCookie,
        hasVbkTicketCookie,
        hasBticketCookie,
        hasJsSessionIdCookie,
        hasBusinessIdCookie,
        hasBfaCookie,
        responseAck: "",
        responseDataItemCount: 0,
      };
      if (!cid && requireReadableCid) {
        throw new Error(`${errorLabel}缺少 cid：请确认 VBK 登录态 Cookie 中存在 GUID 或 vbk_login_cid。`);
      }
      const requestUrl = new URL(endpoint);
      if (includeCidQuery && cid) requestUrl.searchParams.append("_fxpcqlniredt", cid);
      if (cid) requestUrl.searchParams.set("x-traceID", `${cid}-${Date.now()}-${Math.floor(Math.random() * 10_000_000)}`);
      const bodyRecord = body && typeof body === "object" && !Array.isArray(body)
        ? body as Record<string, unknown>
        : {};
      const currentHead = bodyRecord.head && typeof bodyRecord.head === "object" && !Array.isArray(bodyRecord.head)
        ? bodyRecord.head as Record<string, unknown>
        : null;
      const finalBody: unknown = currentHead
        ? { ...bodyRecord, head: { ...currentHead, ...(cid ? { cid } : {}) } }
        : body;
      // 注入从 cookie 提取的反作弊/追踪头（与控制台请求对齐）：
      //   - x-ctx-ubt-vid 对应 UBT_VID cookie 值（携程反作弊 visitor ID）
      //   - 其它 x-ctx-ubt-* 头需要页面 JS 动态生成，无法在 fetch 里自动复制，
      //     缺失时服务器可能返回空结果（Ack=Success 但无数据）——这正是当前
      //     「curl 有结果、系统查不到」的原因之一。
      const extraHeaders: Record<string, string> = {};
      if (ubtVidValue) {
        extraHeaders["x-ctx-ubt-vid"] = ubtVidValue;
        // x-ctx-ubt-sid 通常是固定值 11（来自控制台观察）
        extraHeaders["x-ctx-ubt-sid"] = "11";
      }
      const response = await fetch(requestUrl.toString(), {
        method: "POST",
        credentials: "include",
        headers: { ...headers, ...extraHeaders },
        referrer,
        referrerPolicy,
        body: JSON.stringify(finalBody),
        signal: controller.signal,
      });
      const text = await response.text();
      // VBK 行程 ID 为 18 位整数，直接 JSON.parse 会超过 Number.MAX_SAFE_INTEGER
      // 并静默改写末位。只把协议中已知的行程 ID 字段转成字符串，其他数值保持原样。
      const idSafeText = text.replace(
        /("(?:tourInfoId|previewTourInfoId|auditTourInfoId|draftTourInfoId|tourInfoScoreId|tourDaily[A-Za-z]+Id)"\s*:\s*)(\d{16,})/g,
        '$1"$2"',
      );
      // 从响应中提取 Ack 和数据条数（仅诊断用，不入日志 payload）：
      //  Ack 用于判断「业务成功但数据为空」vs「业务失败」；
      //  dataItemCount 用于确认 suggestPoi 是否返回了候选。
      try {
        const parsed: unknown = JSON.parse(idSafeText);
        const parsedRecord = parsed && typeof parsed === "object" && !Array.isArray(parsed)
          ? parsed as Record<string, unknown>
          : null;
        const rspStatus = parsedRecord
          ? parsedRecord.ResponseStatus
          : null;
        const rspStatusRecord = rspStatus && typeof rspStatus === "object" && !Array.isArray(rspStatus)
          ? rspStatus as Record<string, unknown>
          : null;
        const ack = rspStatusRecord
          ? String(rspStatusRecord.Ack ?? "").slice(0, 200)
          : "";
        ctx.responseAck = ack;
        // 统计顶层 / data.* 下的 poiDtos / body / poiList 条目数。
        // 计数逻辑内联在此（不可走模块作用域 helper，因 evaluate 闭包需可序列化）。
        const candidates: unknown[] = [];
        if (parsedRecord) {
          const dataField = parsedRecord.data;
          const dataRecord = dataField && typeof dataField === "object" && !Array.isArray(dataField)
            ? dataField as Record<string, unknown>
            : null;
          for (const key of ["poiDtos", "body", "poiList"] as const) {
            const top = parsedRecord[key];
            if (Array.isArray(top)) candidates.push(...top);
          }
          if (dataRecord) {
            for (const key of ["poiDtos", "body", "poiList"] as const) {
              const nested = dataRecord[key];
              if (Array.isArray(nested)) candidates.push(...nested);
            }
          }
        }
        ctx.responseDataItemCount = candidates.length;
      } catch { /* 解析失败不影响主流程 */ }
      if (!response.ok) throw new Error(`${errorLabel}失败：HTTP ${response.status}`);
      let payload: unknown;
      try {
        payload = JSON.parse(idSafeText);
      } catch {
        throw new Error(`${errorLabel}返回无效 JSON`);
      }
      return { status: response.status, payload, durationMs: Date.now() - startedAt, ctx };
    } catch (error) {
      if (controller.signal.aborted) throw new Error(`${errorLabel}浏览器请求超时（${timeoutMs}ms）`);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }, {
    endpoint: options.endpoint,
    body: options.body,
    timeoutMs: browserRequestTimeoutMs,
    errorLabel: options.errorLabel,
    headers: requestHeaders(options.headers),
    referrer: options.referrer,
    referrerPolicy: options.referrerPolicy,
    includeCidQuery: options.includeCidQuery !== false,
    requireReadableCid: options.requireReadableCid === true,
  });
  let result: VbkSessionRequestResult;
  try {
    result = await rejectAfter(
      evaluation,
      evaluateTimeoutMs,
      `${options.errorLabel}BrowserView 执行超时（${evaluateTimeoutMs}ms）`,
    ) as VbkSessionRequestResult;
  } catch (error) {
    if (!browser.vbkSessionFetch
      || !EVALUATE_RETRY_NETWORK_PATTERN.test(String(error))) {
      throw error;
    }
    result = await browser.vbkSessionFetch({
      endpoint: options.endpoint,
      body: options.body,
      errorLabel: options.errorLabel,
      headers: requestHeaders(options.headers),
      referrer: options.referrer,
      referrerPolicy: options.referrerPolicy,
      includeCidQuery: options.includeCidQuery !== false,
      requireReadableCid: options.requireReadableCid === true,
      timeoutMs: browserRequestTimeoutMs,
    });
  }
  if (result.status < 200 || result.status >= 300) {
    throw new Error(`${options.errorLabel}失败：HTTP ${result.status}`);
  }
  return result;
}