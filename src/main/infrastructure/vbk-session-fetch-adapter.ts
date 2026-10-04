import type { Session } from "electron";
import type { Page } from "playwright";
import type {
  VbkSessionContext,
  VbkSessionNativeRequest,
  VbkSessionNativeResult,
  VbkSessionNativeTextRequest,
  VbkSessionNativeTextResult,
} from "./vbk-session-request.js";

/**
 * Ephemeral native-fetch observation. Consumers must immediately project their
 * own whitelist; this adapter never persists request bodies or session data.
 */
export type VbkSessionFetchObserver = (exchange: {
  endpoint: string;
  /** Timestamp at native request start, before its response is read. */
  observedAt: string;
  requestBody: object;
  responsePayload: unknown;
}) => void;

const fetchObservers = new WeakMap<object, Set<VbkSessionFetchObserver>>();

export function observeVbkSessionFetch(page: Page, observer: VbkSessionFetchObserver): () => void {
  const target = page as object;
  const observers = fetchObservers.get(target) ?? new Set<VbkSessionFetchObserver>();
  observers.add(observer);
  fetchObservers.set(target, observers);
  return () => {
    observers.delete(observer);
    if (!observers.size) fetchObservers.delete(target);
  };
}

function observeNativeFetch(page: Page, endpoint: string, observedAt: string, requestBody: object, responsePayload: unknown): void {
  for (const observer of fetchObservers.get(page as object) ?? []) {
    try { observer({ endpoint, observedAt, requestBody, responsePayload }); } catch { /* diagnostics never affect the request */ }
  }
}

function emptyContext(): VbkSessionContext {
  return {
    hasCid: false, cookieNameCount: 0, hasGuidCookie: false, hasVbkLoginCidCookie: false,
    hasUbtVidCookie: false, hasVbkTicketCookie: false, hasBticketCookie: false,
    hasJsSessionIdCookie: false, hasBusinessIdCookie: false, hasBfaCookie: false,
    responseAck: "", responseDataItemCount: 0,
  };
}

function safePayload(text: string): unknown {
  const idSafeText = text.replace(
    /("(?:tourInfoId|previewTourInfoId|auditTourInfoId|draftTourInfoId|fromTourInfoId|tourInfoScoreId|tourDaily[A-Za-z]+Id)"\s*:\s*)(\d{16,})/g,
    '$1"$2"',
  );
  return JSON.parse(idSafeText);
}

type SessionCookie = { name: string; value: string };

function sessionContext(cookies: readonly SessionCookie[]) {
  const ctx = emptyContext();
  ctx.cookieNameCount = cookies.length;
  const byName = new Map(cookies.map((cookie) => [cookie.name, cookie.value]));
  const cid = byName.get("GUID") || byName.get("guid") || byName.get("vbk_login_cid") || byName.get("VBK_LOGIN_CID") || "";
  const ubtVid = byName.get("UBT_VID") || "";
  ctx.hasCid = Boolean(cid);
  ctx.hasGuidCookie = byName.has("GUID") || byName.has("guid");
  ctx.hasVbkLoginCidCookie = byName.has("vbk_login_cid") || byName.has("VBK_LOGIN_CID");
  ctx.hasUbtVidCookie = Boolean(ubtVid);
  ctx.hasVbkTicketCookie = byName.has("vbkticket");
  ctx.hasBticketCookie = byName.has("bticket");
  ctx.hasJsSessionIdCookie = byName.has("JSESSIONID");
  ctx.hasBusinessIdCookie = byName.has("vbk-menu-business-id");
  ctx.hasBfaCookie = byName.has("_bfa");
  return { ctx, cid, ubtVid };
}

function sessionRequestParts(request: VbkSessionNativeRequest, cid: string, ubtVid: string) {
  if (!cid && request.requireReadableCid) throw new Error(`${request.errorLabel}缺少 cid`);
  const url = new URL(request.endpoint);
  if (request.includeCidQuery && cid) url.searchParams.append("_fxpcqlniredt", cid);
  if (cid) url.searchParams.set("x-traceID", `${cid}-${Date.now()}-${Math.floor(Math.random() * 10_000_000)}`);
  const source = request.body as Record<string, unknown>;
  const head = source.head && typeof source.head === "object" ? source.head as Record<string, unknown> : null;
  const body = head ? { ...source, head: { ...head, ...(cid ? { cid } : {}) } } : source;
  const headers = {
    ...request.headers,
    ...(ubtVid ? { "x-ctx-ubt-vid": ubtVid, "x-ctx-ubt-sid": "11" } : {}),
  };
  return { url: url.toString(), body, headers };
}

/** Chromium validates a manually supplied Referer against its default policy. */
function nativeReferrer(endpoint: string, source?: string, policy?: VbkSessionNativeRequest["referrerPolicy"]): string | undefined {
  if (!source) return undefined;
  const target = new URL(endpoint);
  const from = new URL(source);
  if (!/^https?:$/.test(from.protocol) || (from.protocol === "https:" && target.protocol === "http:")) return undefined;
  return from.origin === target.origin || policy === "no-referrer-when-downgrade" ? from.href : `${from.origin}/`;
}

function finishSessionResponse(status: number, text: string, startedAt: number, ctx: VbkSessionContext, errorLabel: string): VbkSessionNativeResult {
  let payload: unknown;
  try { payload = safePayload(text); } catch { throw new Error(`${errorLabel}返回无效 JSON`); }
  const root = payload && typeof payload === "object" && !Array.isArray(payload) ? payload as Record<string, any> : {};
  ctx.responseAck = String(root.ResponseStatus?.Ack ?? "").slice(0, 200);
  return { status, payload, durationMs: Date.now() - startedAt, ctx };
}

/** 给 Playwright Page 附加同一 Electron partition 的原生 fetch，供 CORS 拒绝时使用。 */
export function attachVbkSessionFetch(page: Page, electronSession: Session, assertActive: () => void = () => {}): void {
  const target = page as Page & {
    vbkSessionFetch?: (request: VbkSessionNativeRequest) => Promise<VbkSessionNativeResult>;
    vbkSessionGetText?: (request: VbkSessionNativeTextRequest) => Promise<VbkSessionNativeTextResult>;
  };
  if (!target.vbkSessionFetch) target.vbkSessionFetch = async (request) => {
    const startedAt = Date.now();
    const cookies = await electronSession.cookies.get({ url: "https://vbooking.ctrip.com/" });
    const { ctx, cid, ubtVid } = sessionContext(cookies);
    const parts = sessionRequestParts(request, cid, ubtVid);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), request.timeoutMs ?? 12_000);
    try {
      assertActive();
      const referrer = nativeReferrer(parts.url, request.referrer ?? page.url(), request.referrerPolicy);
      const origin = referrer && new URL(referrer).hostname === "vbooking.ctrip.com"
        && new URL(parts.url).hostname === "online.ctrip.com" ? new URL(referrer).origin : undefined;
      let businessCookies: string | undefined;
      if (request.businessContext) {
        const target = new URL(parts.url);
        if (target.origin !== "https://online.ctrip.com" || target.pathname !== "/restapi/soa2/15638/saveSaleControlInfo") {
          throw new Error("业务上下文仅用于携程产品创建接口");
        }
        const { businessId, travelType } = request.businessContext;
        if (!Number.isInteger(businessId) || businessId <= 0 || !Number.isInteger(travelType) || travelType < 0) {
          throw new Error("无效的产品业务上下文");
        }
        const endpointCookies = await electronSession.cookies.get({ url: parts.url });
        businessCookies = endpointCookies.filter(cookie => !cookie.name.startsWith("vbk-menu-business-"))
          .map(cookie => `${cookie.name}=${cookie.value}`).concat([
            `vbk-menu-business-id=${businessId}`,
            `vbk-menu-business-parameter=${encodeURIComponent(JSON.stringify({ businessId: String(businessId), travelType: String(travelType) }))}`,
          ]).join("; ");
      }
      assertActive();
      const response = await electronSession.fetch(parts.url, {
        method: "POST",
        // Chromium otherwise replaces an explicit Cookie header with its jar.
        // The scoped header already carries this account's endpoint cookies.
        credentials: businessCookies ? "omit" : "include",
        signal: controller.signal,
        headers: { ...parts.headers, ...(referrer ? { referer: referrer } : {}), ...(origin ? { origin } : {}),
          ...(businessCookies ? { cookie: businessCookies } : {}) },
        referrer,
        referrerPolicy: request.referrerPolicy,
        body: JSON.stringify(parts.body),
      });
      const text = await response.text();
      const result = finishSessionResponse(response.status, text, startedAt, ctx, request.errorLabel);
      observeNativeFetch(page, request.endpoint, new Date(startedAt).toISOString(), parts.body, result.payload);
      return result;
    } finally { clearTimeout(timer); }
  };
  if (!target.vbkSessionGetText) target.vbkSessionGetText = async (request) => {
    assertActive();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20_000);
    try {
      const referrer = nativeReferrer(request.endpoint, request.referrer, request.referrerPolicy);
      const response = await electronSession.fetch(request.endpoint, {
        method: "GET",
        credentials: "include",
        signal: controller.signal,
        headers: { ...request.headers, ...(referrer ? { referer: referrer } : {}) },
        referrer,
        referrerPolicy: request.referrerPolicy,
      });
      return { status: response.status, text: await response.text() };
    } finally { clearTimeout(timer); }
  };
}

/** 给独立 Playwright live-E2E 附加共享 BrowserContext Cookie 的安全重试请求。 */
export function attachPlaywrightSessionFetch(page: Page): void {
  const target = page as Page & {
    vbkSessionFetch?: (request: VbkSessionNativeRequest) => Promise<VbkSessionNativeResult>;
    vbkSessionGetText?: (request: VbkSessionNativeTextRequest) => Promise<VbkSessionNativeTextResult>;
  };
  const userAgent = Promise.resolve()
    .then(() => page.evaluate(() => navigator.userAgent))
    .then((value) => value.replace(/[^\x20-\x7E]/g, "").trim() || "Mozilla/5.0")
    .catch(() => "Mozilla/5.0");
  if (!target.vbkSessionFetch) target.vbkSessionFetch = async (request) => {
    const startedAt = Date.now();
    const cookies = await page.context().cookies();
    const { ctx, cid, ubtVid } = sessionContext(cookies);
    const parts = sessionRequestParts(request, cid, ubtVid);
    const response = await page.context().request.fetch(parts.url, {
      method: "POST",
      headers: { ...parts.headers, referer: request.referrer ?? page.url(), "user-agent": await userAgent },
      data: JSON.stringify(parts.body),
    });
    const result = finishSessionResponse(response.status(), await response.text(), startedAt, ctx, request.errorLabel);
    observeNativeFetch(page, request.endpoint, new Date(startedAt).toISOString(), parts.body, result.payload);
    return result;
  };
  if (!target.vbkSessionGetText) target.vbkSessionGetText = async (request) => page.evaluate(async ({ endpoint, headers }) => {
    const response = await fetch(endpoint, {
      method: "GET",
      credentials: "include",
      headers,
    });
    return { status: response.status, text: await response.text() };
  }, { endpoint: request.endpoint, headers: request.headers });
}
