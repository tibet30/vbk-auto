import type { Page } from "playwright";
import type { ProductDetail } from "../../../shared/contracts.js";
import { hotelResourceCity, hotelResourceQuery } from "./query.js";
import { searchVbkResources } from "./search.js";
import { firstHotelResource } from "./match.js";

/** Existing non-platform plan remains explicit; it is never a verified platform resource ID. */
export async function resolveHotelResource(page: Page, product: ProductDetail) {
  const query = hotelResourceQuery(product);
  const city = hotelResourceCity(product);
  if (!city) throw new Error("缺少目的城市，无法匹配 VBK 酒店资源。");
  const payload = await searchVbkResources(page);
  const selected = firstHotelResource(payload, city);
  const operations = product.product.operations && typeof product.product.operations === "object" && !Array.isArray(product.product.operations) ? product.product.operations as Record<string, unknown> : {};
  const totalCount = payload && typeof payload === "object" && !Array.isArray(payload) ? Number((payload as Record<string, unknown>).totalCount) || 0 : 0;
  const resolved = selected || { source: "nonPlatform" as const, resourceName: `${query}（非平台）`, query };
  const note = selected
    ? `已查询 VBK 的 ${totalCount} 条有效资源，匹配酒店资源：${selected.resourceName}（ID ${selected.resourceId}）${selected.supplierCode ? `，供应商编码 ${selected.supplierCode}` : ""}。`
    : `已查询 VBK 的 ${totalCount} 条有效资源，当前账号没有匹配的酒店资源；按既定“${query}”非平台酒店方案录入，无需人工补资源 ID。`;
  return { product: { ...product.product, operations: { ...operations, hotelResource: resolved } }, resolved, note };
}
