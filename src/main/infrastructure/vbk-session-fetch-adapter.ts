import type { Session } from "electron";
import type { Page } from "playwright";
import type {
  VbkSessionContext,
  VbkSessionNativeRequest,
  VbkSessionNativeResult,
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

/** 给 Playwright Page 附加同一 Electron partition 的原生 fetch，供 CORS 拒绝时使用。 */
export function attachVbkSessionFetch(page: Page, electronSession: Session): void {
  const target = page as Page & { vbkSessionFetch?: (request: VbkSessionNativeRequest) => Promise<VbkSessionNativeResult> };
  if (target.vbkSessionFetch) return;
  target.vbkSessionFetch = async (request) => {
    const startedAt = Date.now();
    const cookies = await electronSession.cookies.get({});
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
    if (!cid && request.requireReadableCid) throw new Error(`${request.errorLabel}缺少 cid`);
    const url = new URL(request.endpoint);
    if (request.includeCidQuery && cid) url.searchParams.append("_fxpcqlniredt", cid);
    if (cid) url.searchParams.set("x-traceID", `${cid}-${Date.now()}-${Math.floor(Math.random() * 10_000_000)}`);
    const source = request.body as Record<string, unknown>;
    const head = source.head && typeof source.head === "object" ? source.head as Record<string, unknown> : null;
    const body = head ? { ...source, head: { ...head, ...(cid ? { cid } : {}) } } : source;
    const response = await electronSession.fetch(url.toString(), {
      method: "POST",
      headers: {
        ...request.headers,
        ...(ubtVid ? { "x-ctx-ubt-vid": ubtVid, "x-ctx-ubt-sid": "11" } : {}),
      },
      referrer: request.referrer,
      referrerPolicy: request.referrerPolicy,
      body: JSON.stringify(body),
    });
    const text = await response.text();
    let payload: unknown;
    try { payload = safePayload(text); } catch { throw new Error(`${request.errorLabel}返回无效 JSON`); }
    const root = payload && typeof payload === "object" && !Array.isArray(payload) ? payload as Record<string, any> : {};
    ctx.responseAck = String(root.ResponseStatus?.Ack ?? "").slice(0, 200);
    return { status: response.status, payload, durationMs: Date.now() - startedAt, ctx };
  };
}
