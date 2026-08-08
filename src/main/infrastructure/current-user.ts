/**
 * 当前用户信息解析与归一化：
 *   - fetchCurrentUserInfo：在 VBK 浏览器里调 /restapi/soa2/12405/getCurrentUserInfo，
 *     回主进程后通过 decodeCurrentUserInfo 解码；
 *   - decodeCurrentUserInfo：先搜 userInfo / currentUser，再广撒网递归找 partyId；
 *     partyId 即 providerId（携程不同场景不同名字）。
 *
 * 顶部 `normalizeVbkDisplayName` 拒绝把数字 ID 之类当账号名展示；登录账号 `vbk_xxx`
 * 仅匹配 vbk_* 形式，避免误把 partyId 当登录账号。
 */

import type { Page } from "playwright";

/**
 * 在已登录的 VBK 浏览器上下文里调 getCurrentUserInfo 接口，返回当前账号信息。
 * 该接口响应里 `partyId` 即为 providerId（携程把同一概念在不同场景下叫不同名）。
 *
 * 与 hotel-resource.ts / butler-contacts.ts 一样，走 page.evaluate + fetch：
 * cookies 由 BrowserView 的 session 自动带上，跨域也不需要 CORS 配置。
 */
export async function fetchCurrentUserInfo(page: Page): Promise<CurrentUserInfo | null> {
  const payload = await page.evaluate(async () => {
    const readCookie = (name: string) => {
      const match = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
      return match ? decodeURIComponent(match[1]) : "";
    };
    const cid = readCookie("GUID") || readCookie("vbk_login_cid") || `${Date.now()}`;
    const trace = `${cid}-${Date.now()}-${Math.floor(Math.random() * 10_000_000)}`;
    const endpoint = `https://online.ctrip.com/restapi/soa2/12405/getCurrentUserInfo?_fxpcqlniredt=${encodeURIComponent(cid)}&x-traceID=${encodeURIComponent(trace)}`;
    console.warn("[providerId] page.evaluate fetch →", endpoint, "origin:", location.origin);
    const response = await fetch(endpoint, {
      method: "POST", credentials: "include",
      headers: {
        accept: "*/*",
        "content-type": "application/json",
        "x-ctx-currency": "CNY",
        "x-ctx-locale": "zh-CN",
        "x-tour-auth-from": "vbk_online",
      },
      body: JSON.stringify({
        needMenu: false,
        needUserInfo: true,
        needPermission: true,
        needToolBar: false,
        needHeadBar: false,
        applicationCode: "vbk_online",
        head: {
          cid, ctok: "", cver: "1.0", lang: "01", sid: "8888", syscode: "09",
          auth: "", xsid: "", extension: [],
        },
      }),
    });
    const text = await response.text();
    // 把状态码和原文带回主进程，方便主进程侧打日志诊断。
    // Playwright 默认不把 page.evaluate 里的 console 输出转发到 Node，
    // 因此这里走返回值。
    if (!response.ok) throw new Error(`VBK getCurrentUserInfo 失败：HTTP ${response.status} ${text.slice(0, 200)}`);
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { parsed = text; }
    return { __status: response.status, __raw: text.slice(0, 4000), payload: parsed };
  });
  const status = (payload as { __status?: unknown })?.__status;
  const raw = (payload as { __raw?: unknown })?.__raw;
  const body = (payload as { payload?: unknown })?.payload ?? payload;
  console.warn(`[providerId] HTTP ${status}; raw first 600 chars:`);
  console.warn(typeof raw === "string" ? raw.slice(0, 600) : JSON.stringify(raw).slice(0, 600));
  const decoded = decodeCurrentUserInfo(body);
  return decoded;
}

export interface CurrentUserInfo {
  partyId: number;
  displayName?: string;
  loginAccount?: string;
  /** 完整响应原样透出，方便上层读取其它字段（如店铺 ID、菜单等）。 */
  raw: Record<string, unknown>;
}

/**
 * 账号展示必须使用名称，不能把 partyId/providerId 或页面里的“ID：123”当成账号名。
 */
export function normalizeVbkDisplayName(value: unknown): string {
  if (typeof value !== "string") return "";
  const name = value.trim();
  if (!name) return "";
  if (/^(?:(?:provider|party)?id)\s*[:：]?\s*\d+$/i.test(name)) return "";
  if (/^\d+$/.test(name)) return "";
  return name;
}

export function normalizeVbkLoginAccount(value: unknown): string {
  if (typeof value !== "string") return "";
  const account = value.trim();
  return /^vbk_[a-z0-9_-]+$/i.test(account) ? account : "";
}

/**
 * 把 fetchCurrentUserInfo 返回的 payload 解析为 CurrentUserInfo：
 *   - 1) 优先查 responseBody/data/result 的 userInfo / currentUser / user 等；
 *   - 2) 拿不到时广撒网递归（深度 6）找 partyId；
 *   - 任何阶段找不到返回 null（不掉链子，让上层决定用什么兜底）。
 */
function decodeCurrentUserInfo(payload: unknown): CurrentUserInfo | null {
  if (!payload || typeof payload !== "object") return null;
  const root = payload as Record<string, unknown>;
  const explicitUser = extractVbkUser(root);
  // 先把 responseBody / data / root 都纳入搜索范围
  const roots: Array<{ label: string; value: Record<string, unknown> }> = [];
  for (const key of ["responseBody", "data", "result"]) {
    const value = root[key];
    if (value && typeof value === "object" && !Array.isArray(value)) roots.push({ label: key, value: value as Record<string, unknown> });
  }
  roots.push({ label: "root", value: root });

  // 1) 优先：VBK 当前接口里的 user.name / user.account 是人工可读展示名与登录账号。
  // 其它字段只作为兼容兜底，避免把 providerId 或其它内部 ID 当成登录账号。
  const partyIdKeys = ["partyId", "providerId", "vendorId", "partyid", "providerid", "vendorid"];
  const nameKeys = ["userName", "displayName", "name", "userNameZh"];
  const loginAccountKeys = ["loginAccount", "loginName", "accountName", "account", "userAccount", "userCode", "loginId", "userId"];
  for (const r of roots) {
    for (const userInfoKey of ["userInfo", "currentUser", "userInfoWrap", "user", "data"]) {
      const candidate = r.value[userInfoKey];
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
      const user = candidate as Record<string, unknown>;
      for (const pk of partyIdKeys) {
        const id = toPartyId(user[pk]);
        if (id) {
          const localUser = userInfoKey === "user" ? extractUserFields(user) : undefined;
          const displayName = normalizeVbkDisplayName(explicitUser.name)
            || normalizeVbkDisplayName(localUser?.name)
            || nameKeys.map((k) => normalizeVbkDisplayName(user[k])).find((v) => v);
          const loginAccount = explicitUser.account
            || localUser?.account
            || loginAccountKeys.map((k) => normalizeVbkLoginAccount(user[k])).find((v) => v)
            || searchLoginAccountDeep(user)
            || searchLoginAccountDeep(r.value);
          return { partyId: id, displayName: displayName || undefined, loginAccount: loginAccount || undefined, raw: r.value };
        }
      }
    }
  }
  // 2) 兜底：广撒网扫描任意嵌套层级里的 partyId / providerId / vendorId 字段
  for (const r of roots) {
    const found = searchPartyIdDeep(r.value);
    if (found) {
      const displayName = normalizeVbkDisplayName(explicitUser.name) || normalizeVbkDisplayName(found.name) || undefined;
      const loginAccount = explicitUser.account || found.loginAccount || searchLoginAccountDeep(r.value) || undefined;
      return { partyId: found.value, displayName, loginAccount, raw: r.value };
    }
  }
  return null;
}

const PARTY_ID_KEY_RE = /^(partyid|providerid|vendorid|party_id|provider_id|vendor_id)$/i;
const NAME_KEY_RE = /^(username|displayname|name)$/i;
const LOGIN_ACCOUNT_KEY_RE = /^(loginaccount|loginname|accountname|account|useraccount|usercode|loginid|userid|user_id|user_code)$/i;
/**
 * 在未知结构的 JSON 里（深度 ≤ 6）找 partyId / providerId / vendorId 任一字段；
 * 命中时把同名对象里的 name / loginAccount 一并带回，避免后续再扫一遍。
 */
function searchPartyIdDeep(value: unknown, depth = 0): { value: number; name?: string; loginAccount?: string } | null {
  if (depth > 6 || value == null) return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = searchPartyIdDeep(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  // 先在同一对象里找 partyId；同时记录 name 字段以便回填 displayName
  let partyId: number | null = null;
  let name: string | undefined;
  let loginAccount: string | undefined;
  for (const [key, child] of Object.entries(record)) {
    if (!partyId && PARTY_ID_KEY_RE.test(key)) {
      partyId = toPartyId(child);
    }
    if (name === undefined && typeof child === "string" && NAME_KEY_RE.test(key)) {
      const trimmed = child.trim();
      if (trimmed) name = trimmed;
    }
    if (loginAccount === undefined && LOGIN_ACCOUNT_KEY_RE.test(key)) {
      loginAccount = normalizeVbkLoginAccount(child) || undefined;
    }
  }
  if (partyId) return { value: partyId, name, loginAccount };
  for (const child of Object.values(record)) {
    const found = searchPartyIdDeep(child, depth + 1);
    if (found) return found;
  }
  return null;
}

/**
 * 在未知结构 JSON 里（深度 ≤ 6）找以 vbk_ 开头的登录账号；找不到返回空字符串。
 */
function searchLoginAccountDeep(value: unknown, depth = 0): string {
  if (depth > 6 || value == null) return "";
  if (typeof value === "string") return normalizeVbkLoginAccount(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = searchLoginAccountDeep(item, depth + 1);
      if (found) return found;
    }
    return "";
  }
  if (typeof value !== "object") return "";
  for (const child of Object.values(value as Record<string, unknown>)) {
    const found = searchLoginAccountDeep(child, depth + 1);
    if (found) return found;
  }
  return "";
}

/**
 * 递归（深度 ≤ 6）尝试在 payload 里找 user 节点并抽出 name / account；找不到返回空对象。
 */
function extractVbkUser(value: unknown, depth = 0): { name?: string; account?: string } {
  if (depth > 6 || value == null || typeof value !== "object") return {};
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = extractVbkUser(item, depth + 1);
      if (found.name || found.account) return found;
    }
    return {};
  }
  const record = value as Record<string, unknown>;
  const direct = record.user;
  if (direct && typeof direct === "object" && !Array.isArray(direct)) {
    const fields = extractUserFields(direct as Record<string, unknown>);
    if (fields.name || fields.account) return fields;
  }
  for (const child of Object.values(record)) {
    const found = extractVbkUser(child, depth + 1);
    if (found.name || found.account) return found;
  }
  return {};
}

/**
 * 从 user 节点里抽 name / account 字段（trim + 非空才返回）。
 */
function extractUserFields(user: Record<string, unknown>): { name?: string; account?: string } {
  const name = typeof user.name === "string" ? user.name.trim() : "";
  const account = typeof user.account === "string" ? user.account.trim() : "";
  return {
    name: name || undefined,
    account: account || undefined,
  };
}

/**
 * 把任意 raw 转成正整数 partyId；字符串也能解析（携带「12345」之类场景），其它情况返回 null。
 */
function toPartyId(raw: unknown): number | null {
  if (typeof raw === "number" && Number.isInteger(raw) && raw > 0) return raw;
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    const parsed = Number(trimmed);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
  }
  return null;
}
