export interface VbkSessionRequestBrowser {
  evaluate<T, A = unknown>(fn: (arg: A) => T | Promise<T>, arg: A): Promise<T>;
}

export interface VbkSessionContext {
  hasCid: boolean;
  cookieNameCount: number;
  hasGuidCookie: boolean;
  hasVbkLoginCidCookie: boolean;
  /** VBK 反作弊/会话追踪 cookie 是否存在（仅记 bool，不记值）。 */
  hasUbtVidCookie: boolean;
  hasVbkTicketCookie: boolean;
  hasBticketCookie: boolean;
  hasJsSessionIdCookie: boolean;
  hasBusinessIdCookie: boolean;
  hasBfaCookie: boolean;
  /** suggestPoi / searchImage 响应的 Ack 字段文本（原始值，截断 ≤ 200）。 */
  responseAck: string;
  /** suggestPoi 返回的 poiList / body 长度（有数据 > 0）。 */
  responseDataItemCount: number;
}

export interface VbkSessionRequestResult {
  status: number;
  payload: unknown;
  durationMs: number;
  ctx: VbkSessionContext;
}

export interface VbkSessionRequestOptions<TBody extends object = Record<string, unknown>> {
  endpoint: string;
  body: TBody;
  browserRequestTimeoutMs: number;
  evaluateTimeoutMs: number;
  errorLabel: string;
  headers?: Record<string, string>;
  referrer?: string;
  referrerPolicy?: "strict-origin-when-cross-origin";
  includeCidQuery?: boolean;
}

export const EMPTY_VBK_SESSION_CONTEXT: VbkSessionContext = {
  hasCid: false,
  cookieNameCount: 0,
  hasGuidCookie: false,
  hasVbkLoginCidCookie: false,
  hasUbtVidCookie: false,
  hasVbkTicketCookie: false,
  hasBticketCookie: false,
  hasJsSessionIdCookie: false,
  hasBusinessIdCookie: false,
  hasBfaCookie: false,
  responseAck: "",
  responseDataItemCount: 0,
};

export const DEFAULT_VBK_SOA_HEADERS: Record<string, string> = {
  accept: "*/*",
  "content-type": "application/json;charset=UTF-8",
  "x-ctx-currency": "CNY",
  "x-ctx-locale": "zh-CN",
};

export class VbkSessionRequestTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VbkSessionRequestTimeoutError";
  }
}

export async function vbkSessionRequest<TBody extends object>(
  browser: VbkSessionRequestBrowser,
  options: VbkSessionRequestOptions<TBody>,
): Promise<VbkSessionRequestResult> {
  const browserRequestTimeoutMs = timeoutOrDefault(options.browserRequestTimeoutMs, 12_000);
  const evaluateTimeoutMs = timeoutOrDefault(options.evaluateTimeoutMs, 15_000);
  const evaluation = browser.evaluate(async ({
    body,
    endpoint,
    errorLabel,
    headers,
    includeCidQuery,
    referrer,
    referrerPolicy,
    timeoutMs,
  }: {
    body: TBody;
    endpoint: string;
    errorLabel: string;
    headers: Record<string, string>;
    includeCidQuery: boolean;
    referrer?: string;
    referrerPolicy?: "strict-origin-when-cross-origin";
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
      const ctx: VbkSessionContext = {
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
      if (!cid) {
        throw new Error(`${errorLabel}缺少 cid：请确认 VBK 登录态 Cookie 中存在 GUID 或 vbk_login_cid。`);
      }
      const requestUrl = new URL(endpoint);
      if (includeCidQuery) requestUrl.searchParams.append("_fxpcqlniredt", cid);
      requestUrl.searchParams.set("x-traceID", `${cid}-${Date.now()}-${Math.floor(Math.random() * 10_000_000)}`);
      const bodyRecord = body && typeof body === "object" && !Array.isArray(body)
        ? body as Record<string, unknown>
        : {};
      const currentHead = bodyRecord.head && typeof bodyRecord.head === "object" && !Array.isArray(bodyRecord.head)
        ? bodyRecord.head as Record<string, unknown>
        : null;
      const finalBody: unknown = currentHead ? { ...bodyRecord, head: { ...currentHead, cid } } : body;
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
      // 从响应中提取 Ack 和数据条数（仅诊断用，不入日志 payload）：
      //  Ack 用于判断「业务成功但数据为空」vs「业务失败」；
      //  dataItemCount 用于确认 suggestPoi 是否返回了候选。
      try {
        const parsed: unknown = JSON.parse(text);
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
        payload = JSON.parse(text);
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
    headers: { ...DEFAULT_VBK_SOA_HEADERS, ...(options.headers ?? {}) },
    referrer: options.referrer,
    referrerPolicy: options.referrerPolicy,
    includeCidQuery: options.includeCidQuery !== false,
  });
  const result = await rejectAfter(
    evaluation,
    evaluateTimeoutMs,
    `${options.errorLabel}BrowserView 执行超时（${evaluateTimeoutMs}ms）`,
  ) as VbkSessionRequestResult;
  if (result.status < 200 || result.status >= 300) {
    throw new Error(`${options.errorLabel}失败：HTTP ${result.status}`);
  }
  return result;
}

function timeoutOrDefault(value: number | undefined, fallback: number) {
  return Number.isFinite(value) && value! > 0 ? Math.floor(value!) : fallback;
}

function rejectAfter<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return new Promise<T>((resolve, reject) => {
    timer = setTimeout(() => reject(new VbkSessionRequestTimeoutError(message)), timeoutMs);
    promise.then(resolve, reject).finally(() => { if (timer) clearTimeout(timer); });
  });
}
