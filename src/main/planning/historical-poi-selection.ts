import type { ProductDetail } from "../../shared/contracts.js";
import type { VbkDatabase } from "../infrastructure/database/database.js";

type Database = Pick<VbkDatabase, "listProducts" | "getProduct" | "getAgentSnapshot">;
const compact = (value: unknown) => String(value ?? "").replace(/\s+/gu, "");
const basic = (product: ProductDetail) => (product.product.basicInfo ?? {}) as Record<string, unknown>;
type Day = { day: number; spots?: Array<{ name?: string; poiId?: number; poiName?: string }> };
const itinerary = (product: ProductDetail): Day[] => Array.isArray(product.product.itinerary) ? product.product.itinerary : [];
const brief = (product: ProductDetail) => compact(basic(product).userIdea);

/** Only reuse a human-confirmed binding from a completed identical brief/account/day. */
export function historicalConfirmedPoiId(db: Database, current: ProductDetail, keyword: string): number | undefined {
  if (!current.vbkAccount || !brief(current)) return undefined;
  const days = itinerary(current).filter(day => day.spots?.some(spot => compact(spot.name) === compact(keyword))).map(day => day.day);
  if (days.length !== 1) return undefined;
  const ids = new Set<number>();
  for (const summary of db.listProducts()) {
    if (summary.id === current.id) continue;
    const previous = db.getProduct(summary.id);
    if (!previous || previous.vbkAccount !== current.vbkAccount || brief(previous) !== brief(current)
      || previous.automation?.status !== "succeeded" || !previous.productId
      || compact(basic(previous).meetingCity) !== compact(basic(current).meetingCity)
      || compact(basic(previous).province) !== compact(basic(current).province)) continue;
    const spots = itinerary(previous).find(day => day.day === days[0])?.spots ?? [];
    for (const spot of spots) {
      if (compact(spot.name) !== compact(keyword) || !spot.poiId || !spot.poiName) continue;
      const confirmed = (db.getAgentSnapshot(previous.id)?.events ?? []).some(event => {
        if (event.type !== "user" || !event.data?.requestId || !event.data.resolvedAnswers) return false;
        return Object.values(event.data.resolvedAnswers as Record<string, unknown>).some(value => {
          const text = typeof value === "string" ? value : "";
          return text.includes(spot.poiName!) && new RegExp(`poiId\\s*[:：]?\\s*${spot.poiId}(?!\\d)`, "i").test(text);
        });
      });
      if (confirmed) ids.add(spot.poiId);
    }
  }
  return ids.size === 1 ? [...ids][0] : undefined;
}
