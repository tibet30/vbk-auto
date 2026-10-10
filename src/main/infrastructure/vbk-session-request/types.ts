/**
 * vbk-session-request 类型 + 默认常量：
 *   - VbkSessionRequestBrowser：可执行 fetch + evaluate 的最小浏览器接口；
 *     - nativeOnly 表示由 Node 端 vbkSessionFetch / vbkSessionGetText 直接代理，
 *       不经过 BrowserView evaluate 路径；
 *   - VbkSessionNativeRequest / VbkSessionNativeTextRequest：Native 代理请求结构；
 *   - VbkReferrerPolicy：仅暴露平台验证过的两种策略；
 *   - VbkSessionContext：会话探针结果（CID / cookie 名 / Ack / 数据条数）；
 *   - VbkSessionRequestResult：返回结果（status / payload / durationMs / ctx）；
 *   - VbkSessionRequestOptions：业务侧调用入口；
 *   - DEFAULT_VBK_SOA_HEADERS / EMPTY_VBK_SESSION_CONTEXT：常量。
 */

export interface VbkSessionRequestBrowser {
  /** Session clients have no renderer execution context. */
  nativeOnly?: boolean;
  evaluate<T, A = unknown>(fn: (arg: A) => T | Promise<T>, arg: A): Promise<T>;
  vbkSessionFetch?: (request: VbkSessionNativeRequest) => Promise<VbkSessionNativeResult>;
  vbkSessionGetText?: (request: VbkSessionNativeTextRequest) => Promise<VbkSessionNativeTextResult>;
}

export interface VbkSessionNativeRequest {
  /** Per-request business selection; never changes the account cookie jar. */
  businessContext?: { businessId: number; travelType: number };
  endpoint: string;
  body: object;
  errorLabel: string;
  headers: Record<string, string>;
  referrer?: string;
  referrerPolicy?: VbkReferrerPolicy;
  includeCidQuery: boolean;
  requireReadableCid: boolean;
  timeoutMs?: number;
}

export type VbkSessionNativeResult = VbkSessionRequestResult;

export interface VbkSessionNativeTextRequest {
  endpoint: string;
  errorLabel: string;
  headers?: Record<string, string>;
  referrer?: string;
  referrerPolicy?: VbkReferrerPolicy;
}

/** 仅暴露已由 VBK 接口验证过的来源页策略，避免调用方传入任意字符串。 */
export type VbkReferrerPolicy = "strict-origin-when-cross-origin" | "no-referrer-when-downgrade";

export interface VbkSessionNativeTextResult {
  status: number;
  text: string;
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
  businessContext?: VbkSessionNativeRequest["businessContext"];
  endpoint: string;
  body: TBody;
  browserRequestTimeoutMs: number;
  evaluateTimeoutMs: number;
  errorLabel: string;
  headers?: Record<string, string>;
  referrer?: string;
  referrerPolicy?: VbkReferrerPolicy;
  includeCidQuery?: boolean;
  /** 仅少数旧接口硬性要求页面可读 CID；默认允许依赖 HttpOnly/partition Cookie。 */
  requireReadableCid?: boolean;
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
  "accept-language": "zh-CN,zh;q=0.9",
  "x-ctx-currency": "CNY",
  "x-ctx-locale": "zh-CN",
  // suggestPoi 的行政区名语言由 x-input-locale 决定；缺省时西藏等地会回英文 Gyantse。
  "x-input-locale": "zh-CN",
};