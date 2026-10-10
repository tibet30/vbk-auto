import type { CtripHotelCandidate } from "../../shared/contracts-types.js";
import type { VbkDatabase } from "../infrastructure/database/database.js";

type JsonObject = Record<string, unknown>;

/** 汇总本地历史产品中已由携程核验过的候选，供新产品安全复用。 */
export function historicalHotelCandidatePool(db: VbkDatabase, currentProductId: string): CtripHotelCandidate[] {
  return db.listProducts()
    .filter(summary => summary.id !== currentProductId)
    .flatMap(summary => {
      const historical = db.getProduct(summary.id)?.product as JsonObject | undefined;
      const days = Array.isArray(historical?.itinerary) ? historical.itinerary : [];
      const direct = days.flatMap(day => day && typeof day === "object" && !Array.isArray(day)
        && Array.isArray((day as JsonObject).hotelCandidates) ? (day as JsonObject).hotelCandidates : []);
      const resource = historical?.operations && typeof historical.operations === "object" && !Array.isArray(historical.operations)
        ? (historical.operations as JsonObject).hotelResource : undefined;
      const resourceCandidates = resource && typeof resource === "object" && !Array.isArray(resource)
        ? (resource as JsonObject).dailyCandidates : undefined;
      return [...direct, ...(Array.isArray(resourceCandidates) ? resourceCandidates.flatMap(value => {
        if (!value || typeof value !== "object" || Array.isArray(value)) return [];
        const candidates = (value as JsonObject).candidates;
        return Array.isArray(candidates) ? candidates : [];
      }) : [])] as CtripHotelCandidate[];
    });
}
