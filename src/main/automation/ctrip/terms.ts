import { saveStructuredProductClauses } from "./clauses-api.js";
import { enrichItineraryPoiMetadata } from "./itinerary-api/poi-metadata.js";

type ItinerarySpot = {
  name?: string | null;
  poiName?: string | null;
  ticketType?: { key?: number | null } | null;
};

type ItineraryDay = { spots?: ItinerarySpot[] | null };

/**
 * 费用包含的成人首道门票，仅列入 VBK 明确标记为「收费」的行程景点。
 * 以 poiId 去重，避免同一景点跨天游览时重复出现在条款中；没有明确票型的
 * 景点不做推断，避免把未知信息写进对客条款。
 */
export function buildAdultTicketInclusionText(itinerary: ItineraryDay[]): string {
  const names = new Set<string>();
  for (const day of itinerary ?? []) {
    for (const spot of day?.spots ?? []) {
      if (spot?.ticketType?.key !== 1) continue;
      const name = String(spot.poiName ?? spot.name ?? "").trim();
      if (name) names.add(name);
    }
  }
  return [...names].join("+");
}

/**
 * 条款阶段只允许走 API 写入和远端回读。
 *
 * 旧的页面 tab/textarea 保存路径已经废弃：自动化主链会在产品壳创建完成后
 * 调用本函数，因此缺少 productId 必须明确失败，不能降级为 DOM 点击。
 */
export async function fillAndSaveTerms(page: unknown, product: any, productId?: string) {
  if (!productId) throw new Error("条款 API 写入需要 VBK 产品 ID");
  const itinerary = Array.isArray(product.itinerary) ? product.itinerary : [];
  const enrichedItinerary = itinerary.length
    ? await enrichItineraryPoiMetadata(page as never, itinerary)
    : [];
  return saveStructuredProductClauses(page, productId, {
    productForm: product.sales?.productForm,
    adultTicketInclusionText: buildAdultTicketInclusionText(enrichedItinerary),
  });
}
