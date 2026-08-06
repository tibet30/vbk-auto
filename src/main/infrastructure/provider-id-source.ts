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
  // 1) 首选：实时调接口
  try {
    const info = await fetchCurrentUserInfo(page);
    if (info?.partyId) return info.partyId;
  } catch {
    // 接口失败时继续走静态兜底
  }
  // 2) 兜底：从页面静态数据里扫
  const sample = await page.evaluate(() => {
    // 注意：page.evaluate 会把回调序列化成字符串在浏览器里执行，外部模块函数无法被引用。
    // 这里只能把所有用到的逻辑直接写在回调体里；collectProviderIdCandidates 的纯函数
    // 版本保留在外部供单测使用，两边实现必须保持一致。
    const toProviderId = (raw: unknown): number | null => {
      if (typeof raw === "number" && Number.isInteger(raw) && raw > 0) return raw;
      if (typeof raw === "string") {
        const trimmed = raw.trim();
        if (!trimmed) return null;
        const parsed = Number(trimmed);
        return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
      }
      return null;
    };
    const parseCookies = (raw: string): Record<string, string> => {
      const out: Record<string, string> = {};
      for (const segment of raw.split(/;\s*/)) {
        const eq = segment.indexOf("=");
        if (eq <= 0) continue;
        const name = segment.slice(0, eq).trim();
        const value = decodeURIComponent(segment.slice(eq + 1).trim());
        if (name) out[name] = value;
      }
      return out;
    };
    const KEY_RE = /(^|_|\.)(provider|providerid|vendor|vendorid|partyid|partid)(?:$|_|\.)/i;
    const searchInObject = (value: unknown, depth = 0): number | null => {
      if (depth > 4) return null;
      if (value == null) return null;
      if (typeof value === "number" && Number.isInteger(value) && value > 0) return null;
      if (Array.isArray(value)) {
        for (const item of value) {
          const found = searchInObject(item, depth + 1);
          if (found) return found;
        }
        return null;
      }
      if (typeof value === "object") {
        for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
          if (KEY_RE.test(key)) {
            const id = toProviderId(child);
            if (id) return id;
          }
          const nested = searchInObject(child, depth + 1);
          if (nested) return nested;
        }
      }
      return null;
    };
    const scoreKey = (key: string): number => {
      if (key.startsWith("url.")) return 0;
      if (key.startsWith("window.")) return 1;
      if (key === "inline-json") return 2;
      if (key.startsWith("cookie.")) return 3;
      return 99;
    };
    // 收集 + 评分 + 选最优候选；与 collectProviderIdCandidates 逻辑一致。
    const candidates: Array<{ key: string; value: number }> = [];
    const tryAdd = (key: string, raw: unknown) => {
      const id = toProviderId(raw);
      if (id) candidates.push({ key, value: id });
    };
    try {
      const url = new URL(location.href);
      for (const key of ["providerId", "providerid", "provider_id", "vendorId", "vendorid", "partyId", "partyid"]) {
        const value = url.searchParams.get(key);
        if (value) tryAdd(`url.${key}`, value);
      }
    } catch { /* 非合法 URL 跳过 */ }
    const globals: Record<string, unknown> = {
      providerId: (window as unknown as Record<string, unknown>).providerId,
      PROVIDER_ID: (window as unknown as Record<string, unknown>).PROVIDER_ID,
      partyId: (window as unknown as Record<string, unknown>).partyId,
      currentProvider: (window as unknown as Record<string, unknown>).currentProvider,
      currentProviderId: (window as unknown as Record<string, unknown>).currentProviderId,
      vendorId: (window as unknown as Record<string, unknown>).vendorId,
      userInfo: (window as unknown as Record<string, unknown>).userInfo,
      accountInfo: (window as unknown as Record<string, unknown>).accountInfo,
      user: (window as unknown as Record<string, unknown>).user,
      currentUser: (window as unknown as Record<string, unknown>).currentUser,
    };
    for (const [key, value] of Object.entries(globals)) {
      tryAdd(`window.${key}`, value);
      if (value && typeof value === "object") {
        const nested = searchInObject(value);
        if (nested) tryAdd(`window.${key}`, nested);
      }
    }
    const scriptTexts = Array.from(document.querySelectorAll("script")).map((node) => node.textContent || "").filter(Boolean);
    for (const text of scriptTexts) {
      const match = text.match(/\{[\s\S]{40,20000}\}/);
      if (!match) continue;
      let parsed: unknown;
      try { parsed = JSON.parse(match[0]); } catch { continue; }
      const id = searchInObject(parsed);
      if (id) tryAdd("inline-json", id);
      if (candidates.length) break;
    }
    const cookies = parseCookies(document.cookie);
    for (const key of ["vbk-provider-id", "vbk_provider_id", "vbkProviderId"]) {
      tryAdd(`cookie.${key}`, cookies[key]);
    }
    candidates.sort((a, b) => scoreKey(a.key) - scoreKey(b.key));
    return { picked: candidates[0] || null, candidates };
  });
  return sample?.picked?.value ?? null;
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

function searchInObject(value: unknown, depth = 0): number | null {
  if (depth > 4) return null;
  if (value == null) return null;
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    // 裸数字不是 providerId；只在显式键名命中时才认。
    return null;
  }
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

const PROVIDER_ID_KEY_RE = /(^|_|\.)(provider|providerid|vendor|vendorid|partyid|partid)(?:$|_|\.)/i;
function looksLikeProviderIdKey(key: string): boolean {
  return PROVIDER_ID_KEY_RE.test(key);
}

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