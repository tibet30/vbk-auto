/**
 * VBK 酒店资源查询与匹配：在 VBK /restapi/soa2/15638 接口拿资源列表，按城市 + tier 过滤后挑
 * 第一条命中的酒店；命中失败时降级为「非平台酒店」占位，避免污染 pricing/cost 链路。
 */

import type { Page } from "playwright";
import type { ProjectDetail } from "../../shared/contracts.js";

/**
 * 把任意 unknown 转成 trim 后的字符串，空值 / 非字符串返回 ""。
 */
function textValue(value: unknown) { return typeof value === "string" ? value.trim() : ""; }

/**
 * 把任意 unknown 转成正整数，否则返回 undefined；用于安全读取 resourceId 等 ID 字段。
 */
function positiveInteger(value: unknown) { const parsed = Number(value); return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined; }

/**
 * 用「目的城市 + 钻级（例如「三星/五星」）」拼出查询关键字，供前端展示 / VBK 搜索复用。
 * 例：太原三星 → "太原三星"。
 */
export function hotelResourceQuery(project: Pick<ProjectDetail, "product">) {
  const product = project.product;
  const basic = product.basicInfo && typeof product.basicInfo === "object" && !Array.isArray(product.basicInfo) ? product.basicInfo as Record<string, unknown> : {};
  const operations = product.operations && typeof product.operations === "object" && !Array.isArray(product.operations) ? product.operations as Record<string, unknown> : {};
  const city = textValue(basic.destinationCity) || textValue(basic.meetingCity);
  const tier = textValue(operations.hotelTier).replace(/^当地/, "").replace(/\/-\d+$/, "") || "酒店";
  return `${city}${tier}`;
}

/**
 * 在 VBK 页面上下文里直接 fetch 资源列表接口（带 cid trace）：从 cookie 取 GUID，
 * 拼一个 traceID 后用 fetch 调用 restapi/15638；返回 raw payload（JSON.parse 失败则保留文本）。
 */
export async function searchVbkResources(page: Page) {
  return page.evaluate(async () => {
    const readCookie = (name: string) => {
      const match = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
      return match ? decodeURIComponent(match[1]) : "";
    };
    const cid = readCookie("GUID") || readCookie("vbk_login_cid") || `${Date.now()}`;
    const trace = `${cid}-${Date.now()}-${Math.floor(Math.random() * 10_000_000)}`;
    const response = await fetch(`https://online.ctrip.com/restapi/soa2/15638/searchResourceList.json?x-traceID=${encodeURIComponent(trace)}`, {
      method: "POST", credentials: "include",
      headers: { accept: "*/*", "content-type": "application/json", "x-ctx-currency": "CNY", "x-ctx-locale": "zh-CN" },
      body: JSON.stringify({
        contentType: "json", head: { cid, ctok: "", cver: "1.0", lang: "01", sid: "8888", syscode: "09", auth: "", xsid: "", extension: [] },
        resourceIds: [], resourceName: "", departureCityId: null, destinationCityId: null, productRegion: null,
        active: "T", vendorId: null, pmEid: "", paEid: "", createTimeStart: null, createTimeEnd: null,
        forProductCategory: [], forProductPattern: [], forSaleMode: [], pageNo: 1, pageSize: 100,
        vendorResourceCodes: [], businessOwner: "CUSTOM",
      }),
    });
    const text = await response.text();
    let payload: unknown = text;
    try { payload = JSON.parse(text); } catch { /* keep raw text for diagnostics */ }
    if (!response.ok) throw new Error(`VBK 资源列表查询失败：HTTP ${response.status} ${text.slice(0, 160)}`);
    return payload;
  });
}

/**
 * 从 searchVbkResources 返回的 payload 里挑一个酒店资源：
 *   - 先按「酒店 / hotel」关键字段筛出酒店类目；
 *   - 优先挑匹配 city 的；都没有就拿第一条；
 *   - 严格校验 resourceId 必须为正整数；不符合返回 undefined 让上层走非平台占位。
 */
export function firstHotelResource(payload: unknown, city = "") {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  const resources = Array.isArray((payload as Record<string, unknown>).resources) ? (payload as Record<string, unknown>).resources as unknown[] : [];
  const hotels = resources.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const record = item as Record<string, unknown>;
    const category = record.category && typeof record.category === "object" && !Array.isArray(record.category) ? record.category as Record<string, unknown> : {};
    const haystack = `${textValue(record.resourceName)} ${textValue(record.resourceDesc)} ${textValue(record.categoryName)} ${textValue(category.categoryName)}`;
    return /酒店|hotel/i.test(haystack) ? [record] : [];
  });
  const selected = hotels.find((record) => !city || `${textValue(record.destinationCityName)} ${textValue(record.resourceName)} ${textValue(record.resourceDesc)}`.includes(city)) || hotels[0];
  if (!selected) return undefined;
  const resourceId = positiveInteger(selected.resourceId); const resourceName = textValue(selected.resourceName);
  if (!resourceId || !resourceName) return undefined;
  return { source: "vbk" as const, resourceId, resourceName, supplierCode: textValue(selected.vendorResourceCode) || undefined, roomType: textValue(selected.vendorResourceName) || undefined };
}

/**
 * 主入口：解析 project 上的 hotel 资源。
 *   - 缺少目的城市抛错；
 *   - 走 searchVbkResources + firstHotelResource 命中真实资源；
 *   - 命中失败时按「非平台酒店」占位写入 operations.hotelResource；
 *   - 返回 { product, resolved, note }：product 是浅拷贝加酒店资源的版本，note 给 UI 展示。
 */
export async function resolveHotelResource(page: Page, project: ProjectDetail) {
  const query = hotelResourceQuery(project);
  if (!query) throw new Error("缺少目的城市，无法匹配 VBK 酒店资源。");
  const basic = project.product.basicInfo as Record<string, unknown> | undefined;
  const city = textValue(basic?.destinationCity) || textValue(basic?.meetingCity);
  const payload = await searchVbkResources(page);
  const selected = firstHotelResource(payload, city);
  const operations = project.product.operations && typeof project.product.operations === "object" && !Array.isArray(project.product.operations) ? project.product.operations as Record<string, unknown> : {};
  const totalCount = payload && typeof payload === "object" && !Array.isArray(payload) ? Number((payload as Record<string, unknown>).totalCount) || 0 : 0;
  const resolved = selected || { source: "nonPlatform" as const, resourceName: `${query}（非平台）`, query };
  const note = selected
    ? `已查询 VBK 的 ${totalCount} 条有效资源，匹配酒店资源：${selected.resourceName}（ID ${selected.resourceId}）${selected.supplierCode ? `，供应商编码 ${selected.supplierCode}` : ""}。`
    : `已查询 VBK 的 ${totalCount} 条有效资源，当前账号没有匹配的酒店资源；按既定“${query}”非平台酒店方案录入，无需人工补资源 ID。`;
  return { product: { ...project.product, operations: { ...operations, hotelResource: resolved } }, resolved, note };
}
