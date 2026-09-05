import type { Session } from "electron";
import type { Page } from "playwright";
import type {
  VbkSessionContext,
  VbkSessionNativeRequest,
  VbkSessionNativeResult,
  VbkSessionNativeTextRequest,
  VbkSessionNativeTextResult,
} from "./vbk-session-request.js";

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
    /("(?:tourInfoId|previewTourInfoId|auditTourInfoId|draftTourInfoId|tourInfoScoreId|tourDaily[A-Za-z]+Id)"\s*:\s*)(\d{16,})/g,
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
    ...(request.referrer ? { referer: request.referrer } : {}),
  };
  return { url: url.toString(), body, headers };
}

function finishSessionResponse(status: number, text: string, startedAt: number, ctx: VbkSessionContext, errorLabel: string): VbkSessionNativeResult {
  let payload: unknown;
  try { payload = safePayload(text); } catch { throw new Error(`${errorLabel}返回无效 JSON`); }
  const root = payload && typeof payload === "object" && !Array.isArray(payload) ? payload as Record<string, any> : {};
  ctx.responseAck = String(root.ResponseStatus?.Ack ?? "").slice(0, 200);
  return { status, payload, durationMs: Date.now() - startedAt, ctx };
}

/** 给 Playwright Page 附加同一 Electron partition 的原生 fetch，供 CORS 拒绝时使用。 */
export function attachVbkSessionFetch(page: Page, electronSession: Session): void {
  const target = page as Page & {
    vbkSessionFetch?: (request: VbkSessionNativeRequest) => Promise<VbkSessionNativeResult>;
    vbkSessionGetText?: (request: VbkSessionNativeTextRequest) => Promise<VbkSessionNativeTextResult>;
  };
  if (!target.vbkSessionFetch) target.vbkSessionFetch = async (request) => {
    const startedAt = Date.now();
    const cookies = await electronSession.cookies.get({});
    const { ctx, cid, ubtVid } = sessionContext(cookies);
    const parts = sessionRequestParts(request, cid, ubtVid);
    const response = await electronSession.fetch(parts.url, {
      method: "POST",
      headers: parts.headers,
      referrer: request.referrer ?? page.url(),
      referrerPolicy: request.referrerPolicy,
      body: JSON.stringify(parts.body),
    });
    const text = await response.text();
    return finishSessionResponse(response.status, text, startedAt, ctx, request.errorLabel);
  };
  if (!target.vbkSessionGetText) target.vbkSessionGetText = async (request) => {
    const response = await electronSession.fetch(request.endpoint, {
      method: "GET",
      headers: request.headers,
      referrer: request.referrer,
      referrerPolicy: request.referrerPolicy,
    });
    return { status: response.status, text: await response.text() };
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
    return finishSessionResponse(response.status(), await response.text(), startedAt, ctx, request.errorLabel);
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
