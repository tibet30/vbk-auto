import type { ProductDetail } from "../../../shared/contracts.js";
import { normalisePlatformHotelProduct, PLATFORM_HOTEL_DESCRIPTION, validPlatformHotelRules } from "../../../shared/platform-hotel-rules.js";

/** Explicit local configuration; no VBK hotel library or hotel-list request. */
export async function resolveHotelResource(_page: unknown, product: ProductDetail) {
  const next = normalisePlatformHotelProduct(product.product);
  if (!validPlatformHotelRules(next.operations?.hotelRules)) throw new Error("酒店规则缺失或无效");
  return { product: next, resolved: { source: "rules" as const, resourceName: PLATFORM_HOTEL_DESCRIPTION,
    rules: next.operations.hotelRules }, note: "已配置平台自动匹配三钻、四钻、五钻，不指定具体酒店。" };
}
