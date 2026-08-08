/**
 * 在 VBK 页面里抓取当前登录账号的 providerId（供应商 ID）的两层兜底：
 *   - detectProviderIdFromBrowser：首选 fetchCurrentUserInfo（实时接口），
 *     失败时回到静态页面数据扫描（URL / window / 内嵌 JSON / cookie）；
 *   - scheduleProviderIdRefresh：best-effort 后台刷新（立即 + 4s 重试），
 *     用于登录后或运营手动触发 accounts:detectProviderId 时调用。
 *
 * 命中后返回正整数；都拿不到时返回 null，让 UI 提示运营手动输入。
 */

import type { Page } from "playwright";
import { fetchCurrentUserInfo } from "./current-user.js";
/**
 * 在已登录的 VBK 浏览器上下文里抓取当前登录账号对应的 providerId（供应商 ID）。
 *
 * 主要来源：调 getCurrentUserInfo（online.ctrip.com/restapi/soa2/12405），
 * 响应里的 partyId 就是 providerId。
 *
 * 兜底：扫一遍 URL / window / 内嵌 JSON / cookie，用于接口失败或未登录时
 * 仍能从页面静态数据里找到线索。
 *
 * 抓不到返回 null，由 UI 提示运营手动输入。
 */
export async function detectProviderIdFromBrowser(page: Page): Promise<number | null> {
  try {
    const info = await fetchCurrentUserInfo(page);
    if (info?.partyId) return info.partyId;
  } catch {
    // 接口失败时返回 null
    return null;
  }
  return null;
}

/** 在浏览器外可单测的纯函数：从一组原始数据中挑出最可能的 providerId。 */
export function collectProviderIdCandidates(input: { href: string; cookies: string; scriptTexts: string[]; globals: Record<string, unknown> }): { picked: { key: string; value: number } | null; candidates: Array<{ key: string; value: number }> } {
  const candidates: Array<{ key: string; value: number }> = [];
  const tryAdd = (key: string, raw: unknown) => {
    const id = toProviderId(raw);
    if (id) candidates.push({ key, value: id });
  };
  // 1) URL
  try {
    const url = new URL(input.href);
    for (const key of ["providerId", "providerid", "provider_id", "vendorId", "vendorid", "partyId", "partyid"]) {
      const value = url.searchParams.get(key);
      if (value) tryAdd(`url.${key}`, value);
    }
  } catch {
    // href 不是合法 URL 时跳过
  }
  // 2) window 全局常见名字：先尝试直接读，再递归搜对象内的 providerId 字段
  for (const [key, value] of Object.entries(input.globals)) {
    tryAdd(`window.${key}`, value);
    if (value && typeof value === "object") {
      const nested = searchInObject(value);
      if (nested) tryAdd(`window.${key}`, nested);
    }
  }
  // 3) 内嵌 JSON
  for (const text of input.scriptTexts) {
    const match = text.match(/\{[\s\S]{40,20000}\}/);
    if (!match) continue;
    let parsed: unknown;
    try { parsed = JSON.parse(match[0]); } catch { continue; }
    const id = searchInObject(parsed);
    if (id) tryAdd("inline-json", id);
    if (candidates.length) break;
  }
  // 4) cookie
  const cookies = parseCookies(input.cookies);
  for (const key of ["vbk-provider-id", "vbk_provider_id", "vbkProviderId"]) {
    tryAdd(`cookie.${key}`, cookies[key]);
  }
  candidates.sort((a, b) => scoreKey(a.key) - scoreKey(b.key));
  return { picked: candidates[0] || null, candidates };
}

/**
 * 把 document.cookie 字符串解析为 name -> value 的字典，便于扫描时取值。
 */
function parseCookies(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const segment of raw.split(/;\s*/)) {
    const eq = segment.indexOf("=");
    if (eq <= 0) continue;
    const name = segment.slice(0, eq).trim();
    const value = decodeURIComponent(segment.slice(eq + 1).trim());
    if (name) out[name] = value;
  }
  return out;
}

/**
 * 在未知结构 JSON 里（深度 ≤ 4）找第一个「key 看起来像 providerId」的字段：
 *   - 裸数字不认（避免数组里的索引 / 计数数字误判）；
 *   - 命中 looksLikeProviderIdKey 的键时，要求 value 经 toProviderId 转化为正整数；
 *   - 失败才递归。
 */
function searchInObject(value: unknown, depth = 0): number | null {
  if (depth > 4) return null;
  if (value == null) return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = searchInObject(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (typeof value === "object") {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (looksLikeProviderIdKey(key)) {
        const id = toProviderId(child);
        if (id) return id;
      }
      const nested = searchInObject(child, depth + 1);
      if (nested) return nested;
    }
  }
  return null;
}

/** 把任意原始值规整成正整数 providerId；非数字或 ≤0 都返回 null。 */
function toProviderId(raw: unknown): number | null {
  if (typeof raw === "number" && Number.isInteger(raw) && raw > 0) return raw;
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    const parsed = Number(trimmed);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
  }
  return null;
}

/**
 * 「看起来像 providerId」的字段名匹配正则：
 *   - provider / providerId / vendor / vendorId / partyId / partid 任一形式（前后接 _ 或 .）。
 *   - 兼容驼峰 / 下划线 / 中点分隔。
 */
const PROVIDER_ID_KEY_RE = /(^|_|\.)(provider|providerid|vendor|vendorid|partyid|partid)(?:$|_|\.)/i;
function looksLikeProviderIdKey(key: string): boolean {
  return PROVIDER_ID_KEY_RE.test(key);
}

/**
 * 给候选来源打分（升序）：
 *   - URL > window 全局 > 内嵌 JSON > cookie；
 *   - 越靠前越可信，避免 cookie 里旧登录态污染。
 */
function scoreKey(key: string): number {
  // URL > window > 内嵌 JSON > cookie，越靠前越优先
  if (key.startsWith("url.")) return 0;
  if (key.startsWith("window.")) return 1;
  if (key === "inline-json") return 2;
  if (key.startsWith("cookie.")) return 3;
  return 99;
}

/**
 * 把 detectProviderIdFromBrowser 包成一个 best-effort 的「后台刷新」调度：
 * 1. 立刻试一次；
 * 2. 失败时不抛错，再等 4 秒重试；
 * 3. 再失败就放弃。错误只会进 console.warn。
 *
 * 主进程在 VBK 登录后或运营手动触发 accounts:detectProviderId 时调用，
 * 把结果落进 settings(providerIdByAccount:<accountName>)，UI 即可查询。
 */
export async function scheduleProviderIdRefresh(
  _accountName: string,
  detector: (page: Page) => Promise<number | null>,
  persist: (providerId: number | null) => void,
  options?: { page?: Page; now?: () => number },
): Promise<void> {
  const page = options?.page;
  if (!page) return;
  const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
  for (const delayMs of [0, 4_000]) {
    if (delayMs) await sleep(delayMs);
    try {
      const id = await detector(page);
      persist(id);
      return;
    } catch (error) {
      console.warn("[providerId] refresh failed", { delayMs, error: error instanceof Error ? error.message : String(error) });
    }
  }
  persist(null);
}