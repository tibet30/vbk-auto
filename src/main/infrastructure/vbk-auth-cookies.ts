export const VBK_AUTH_COOKIE_INCOMPLETE_MESSAGE = "VBK 登录态不完整，请重新登录或切换账号。";

const TICKET_COOKIE_NAMES = ["vbkticket", "bticket"] as const;
const SESSION_COOKIE_NAME = "JSESSIONID";
const CID_COOKIE_NAMES = ["vbk_login_cid", "GUID"] as const;

export interface VbkAuthCookieSummary {
  count: number;
  presentNames: string[];
  flags: {
    hasVbkTicket: boolean;
    hasBTicket: boolean;
    hasJSessionId: boolean;
    hasVbkLoginCid: boolean;
    hasGuid: boolean;
  };
  missingNames: string[];
}

export function summarizeVbkAuthCookies(cookies: Array<{ name?: string; domain?: string }>): VbkAuthCookieSummary {
  const names = new Set(
    cookies
      .map((cookie) => cookie.name?.trim())
      .filter((name): name is string => Boolean(name)),
  );
  const flags = {
    hasVbkTicket: names.has("vbkticket"),
    hasBTicket: names.has("bticket"),
    hasJSessionId: names.has(SESSION_COOKIE_NAME),
    hasVbkLoginCid: names.has("vbk_login_cid"),
    hasGuid: names.has("GUID"),
  };
  const missingNames: string[] = [];
  if (!flags.hasVbkTicket && !flags.hasBTicket) missingNames.push(TICKET_COOKIE_NAMES.join(" or "));
  if (!flags.hasJSessionId) missingNames.push(SESSION_COOKIE_NAME);
  if (!flags.hasVbkLoginCid && !flags.hasGuid) missingNames.push(CID_COOKIE_NAMES.join(" or "));
  return {
    count: cookies.length,
    presentNames: Array.from(names).sort(),
    flags,
    missingNames,
  };
}

export function isVbkAuthCookieSummaryComplete(summary: VbkAuthCookieSummary): boolean {
  return summary.missingNames.length === 0;
}

export function assertCompleteVbkAuthCookies(summary: VbkAuthCookieSummary): void {
  if (!isVbkAuthCookieSummaryComplete(summary)) {
    throw new Error(VBK_AUTH_COOKIE_INCOMPLETE_MESSAGE);
  }
}
