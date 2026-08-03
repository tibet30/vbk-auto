import type { Page } from "playwright";
import type { ProviderContactCard } from "../shared/contracts.js";

/**
 * 在已登录的 VBK 浏览器上下文里调用携程接口拉取 providerId 对应的联系人卡片列表。
 * 复用 hotel-resource.ts 的 page.evaluate + fetch 模式：cookie 由 BrowserView
 * 的 session 自动携带；head 中的 cid/sid/syscode 等也直接从页面 cookie 读取。
 * searchKeyword 非空时，VBK 服务端按关键字过滤联系人。
 */
export async function listProviderContactCards(page: Page, providerId: number, searchKeyword?: string): Promise<ProviderContactCard[]> {
  if (!Number.isInteger(providerId) || providerId <= 0) throw new Error("providerId 必须为正整数。");
  const trimmedKeyword = (searchKeyword ?? "").trim();
  const payload = await page.evaluate(async ({ providerId, keyword }: { providerId: number; keyword: string }) => {
    const readCookie = (name: string) => {
      const match = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
      return match ? decodeURIComponent(match[1]) : "";
    };
    const cid = readCookie("GUID") || readCookie("vbk_login_cid") || `${Date.now()}`;
    const trace = `${cid}-${Date.now()}-${Math.floor(Math.random() * 10_000_000)}`;
    const response = await fetch(`https://m.ctrip.com/restapi/soa2/17264/searchProviderContactCardList?_fxpcqlniredt=${encodeURIComponent(cid)}&x-traceID=${encodeURIComponent(trace)}`, {
      method: "POST", credentials: "include",
      headers: {
        accept: "*/*",
        "content-type": "application/json",
        "x-ctx-currency": "CNY",
        "x-ctx-locale": "zh-CN",
        "x-tour-auth-from": "vbk",
        referer: location.origin,
      },
      body: JSON.stringify({
        providerId,
        contactType: 0,
        selectedContactCardIdList: [],
        searchKeyWord: keyword,
        version: "v0.4",
        pageIndex: 1,
        pageSize: 50,
        head: {
          cid, ctok: "", cver: "1.0", lang: "01", sid: "8888", syscode: "09",
          auth: "", xsid: "", extension: [],
        },
      }),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`VBK 联系人列表查询失败：HTTP ${response.status} ${text.slice(0, 200)}`);
    let parsed: unknown = text;
    try { parsed = JSON.parse(text); } catch { /* keep raw text */ }
    return parsed;
  }, { providerId, keyword: trimmedKeyword });

  return decodeContactCards(payload, providerId);
}

interface RawContactCard {
  contactCardId?: unknown;
  contactCardName?: unknown;
  providerContactName?: unknown;
  name?: unknown;
  contactName?: unknown;
  // 兜底：有些接口把字段名直接放在顶层
  [key: string]: unknown;
}

function decodeContactCards(payload: unknown, providerId: number): ProviderContactCard[] {
  if (!payload || typeof payload !== "object") return [];
  const root = payload as Record<string, unknown>;
  // 携程接口常见两种返回结构：responseBody.contactCardList 或 contactCardList 直接在根。
  const candidates: unknown[] = [];
  const responseBody = root.responseBody && typeof root.responseBody === "object" && !Array.isArray(root.responseBody)
    ? (root.responseBody as Record<string, unknown>)
    : undefined;
  if (responseBody) {
    if (Array.isArray(responseBody.contactCardList)) candidates.push(...(responseBody.contactCardList as unknown[]));
    if (Array.isArray(responseBody.cards)) candidates.push(...(responseBody.cards as unknown[]));
  }
  if (Array.isArray(root.contactCardList)) candidates.push(...(root.contactCardList as unknown[]));
  if (Array.isArray(root.cards)) candidates.push(...(root.cards as unknown[]));
  if (!candidates.length && Array.isArray(root)) candidates.push(...(root as unknown[]));

  const out: ProviderContactCard[] = [];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    const record = candidate as RawContactCard;
    const id = Number(record.contactCardId);
    if (!Number.isInteger(id) || id <= 0) continue;
    const displayName = [record.contactCardName, record.providerContactName, record.contactName, record.name]
      .map((value) => typeof value === "string" ? value.trim() : "")
      .find((value) => value.length > 0);
    if (!displayName) continue;
    const extra: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(record)) {
      if (key === "contactCardId" || key === "contactCardName" || key === "providerContactName" || key === "contactName" || key === "name") continue;
      extra[key] = value;
    }
    out.push({ contactCardId: id, displayName, providerId, extra: Object.keys(extra).length ? extra : undefined });
  }
  return out;
}