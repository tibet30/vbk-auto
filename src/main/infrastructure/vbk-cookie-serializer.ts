/**
 * 携程 VBK 多账号登录用的 cookie 序列化兼容层。
 *
 * cookies 在 `login_sessions` 表里以 JSON 形式落盘（手动登录/切换账号时
 * 抓出来持久化），下游消费方有两套写法：
 *  - 历史记录是 Playwright 风格（`SerialisedCookie`，没有 url 字段，
 *    sameSite 是 lower-case 字符串）；
 *  - Electron `cookies.set/remove` 要求 `url` 必须是 scheme + host，
 *    sameSite 是有范围的字符串字面量。
 *
 * 本文件只做"DB 字符串 ↔ Electron Cookie 细节"之间的归一化，不依赖
 * vbk-browser.ts，避免拆出去之后再被反向耦合进来。
 */

// ─────────────────────────────────────────────────────────────
// 内部类型：与 Electron.Cookie 字段对齐，但不要求 url（DB 里的历史
// 记录普遍只有 domain）。
// ─────────────────────────────────────────────────────────────

export interface SerialisedCookie {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: string | null;
  url?: string;
}

// ─────────────────────────────────────────────────────────────
// 序列化侧：从 DB 拿出的 raw JSON → 经校验/过滤的 cookie 列表
// ─────────────────────────────────────────────────────────────

/**
 * 从 settings/login_sessions 表读出的 cookie JSON 字符串解析：
 *   - JSON.parse 失败时返回空数组；
 *   - 仅保留结构合法（object + name:string）的条目，下游不必再做 null 检查。
 */
export function parseCookies(raw: string): SerialisedCookie[] {
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is SerialisedCookie =>
      !!entry && typeof entry === "object" && typeof (entry as { name?: unknown }).name === "string"
    );
  } catch {
    return [];
  }
}

// ─────────────────────────────────────────────────────────────
// URL 推导：cookie 没有 url 字段时，根据 domain / secure 拼出
// Electron `cookies.set/remove` 要求的 scheme + host。
// ─────────────────────────────────────────────────────────────

/**
 * 把 cookie 转换成 Electron `cookies.set` 要求的 scheme+host 字符串：
 *   - 优先用 cookie.url；
 *   - 否则根据 domain（去前缀点） + secure 拼出 https/http + host；
 *   - 缺 domain 返回 null 让上层走 remove 接口。
 */
export function cookieUrl(cookie: SerialisedCookie): string | null {
  if (cookie.url) return cookie.url;
  if (!cookie.domain) return null;
  // domain 形如 ".ctrip.com"，规范化成可写 cookies.set 的 url。
  const host = cookie.domain.startsWith(".") ? cookie.domain.slice(1) : cookie.domain;
  const scheme = cookie.secure ? "https" : "http";
  return `${scheme}://${host}`;
}

/**
 * 从完整 URL 反出 hostname，便于和 DB cookie 的 domain 字段对齐。
 * URL 解析失败时返回空字符串。
 */
export function cookieDomain(url: string): string {
  try { return new URL(url).hostname || ""; } catch { return ""; }
}

/**
 * `session.cookies.remove(url, name)` 的 url 必须是 scheme + host。
 * Electron 的 Cookie 结构没有 url，只有 domain ——
 * 注意 domain 可能包含前导点（".ctrip.com"）也可能没有，
 * scheme 也要按 secure 选 https / http。
 */
export function removeUrlFromCookie(cookie: Pick<Electron.Cookie, "domain" | "secure">): string | null {
  if (!cookie.domain) return null;
  const host = cookie.domain.startsWith(".") ? cookie.domain.slice(1) : cookie.domain;
  if (!host) return null;
  const scheme = cookie.secure ? "https" : "http";
  return `${scheme}://${host}`;
}

// ─────────────────────────────────────────────────────────────
// 字段归一化：DB 里的 sameSite/expires 老版本字段形状不统一，转成
// Electron `cookies.set` 期望的字面量。
// ─────────────────────────────────────────────────────────────

/**
 * DB 历史 cookie 的 sameSite 字段统一归一化到 Electron 字面量：
 *   - lax / strict 直传；
 *   - none 与 no_restriction 都映射为 no_restriction；
 *   - 其它/缺失返回 unspecified。
 */
export function normaliseSameSite(value: SerialisedCookie["sameSite"]): "unspecified" | "no_restriction" | "lax" | "strict" {
  if (!value) return "unspecified";
  const lowered = String(value).toLowerCase();
  if (lowered === "lax") return "lax";
  if (lowered === "strict") return "strict";
  if (lowered === "none" || lowered === "no_restriction") return "no_restriction";
  return "unspecified";
}

/**
 * DB cookie 的 expires 时间戳归一化：
 *   - 非数 / 非正 / 无穷值返回 undefined 让 Electron 不写 expirationDate；
 *   - 大于 1e12 自动按毫秒转秒（兼容旧 Playwright 数据）。
 */
export function normaliseExpiry(value: SerialisedCookie["expires"]): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
  // Electron 期望以秒为单位的 unix 时间戳；Playwright 已是同一口径，但保险起见
  // 检测超过 10^12 的毫秒值并转换。
  if (value > 1e12) return Math.floor(value / 1000);
  return Math.floor(value);
}
