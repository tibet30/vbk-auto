import { createHash } from "node:crypto";
import type { ProductDetail } from "../../shared/contracts.js";
import { productSchema } from "../automation/schema/schema.js";

type Json = Record<string, unknown>;
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>[key,canonical(item)]));
}
/** Generated vendor codes and platform binding metadata are not operator choices. */
export function legacyProductVersion(product: Pick<ProductDetail, "product">): string {
  const parsed = productSchema.safeParse(product.product);
  const data = structuredClone(parsed.success ? parsed.data : product.product) as unknown as Json;
  if (data.basicInfo) delete (data.basicInfo as Json).supplierProductCode;
  const ops = data.operations as Json | undefined;
  // In platform-rules mode the legacy named-hotel fields are forbidden and
  // deterministically removed on persistence. They cannot represent a user
  // choice or make an otherwise matching approval stale.
  if (ops?.hotelMatchingMode === "rules") {
    delete ops.hotelTier;
    delete ops.hotelSource;
  }
  const resource = ops?.hotelResource as Json | undefined;
  // The itinerary owns the approved per-day hotel choices. hotelResource is a
  // derived mirror written after the platform phase succeeds (source, selected
  // name, tier, candidates, segment ids, and other readback metadata). Keeping
  // that mirror in the fingerprint invalidates the approval immediately after
  // a successful hotelResource write even though no operator choice changed.
  const days = (Array.isArray(data.itinerary) ? data.itinerary : []) as Json[];
  if (resource && days.some(day=>Array.isArray(day.hotelCandidates) && day.hotelCandidates.length)) {
    // Keep the operator's effective hotel choice (source, resource ID/name,
    // room type, query and tier) in the approval fingerprint. Only strip
    // readback/candidate mirrors that are populated by the platform phase.
    const candidates = days.flatMap(day => Array.isArray(day.hotelCandidates) ? day.hotelCandidates as Json[] : []);
    // Only treat hotelResource as a pure platform mirror when the selected
    // name matches an itinerary candidate. Diamond alone is too weak: a
    // different property at the same tier must remain fingerprinted.
    const selectedFromItinerary = candidates.some(candidate => candidate.hotelName === resource.resourceName);
    if (selectedFromItinerary && !resource.query && !resource.roomType) {
      // A resource generated from the approved daily candidates has no extra
      // operator decision. Ignore its whole platform mirror, while an explicit
      // query/room-type selection remains fingerprinted.
      delete ops!.hotelResource;
    } else {
      delete resource.candidates;
      delete resource.dailyCandidates;
      delete resource.resourceId;
      delete resource.supplierCode;
    }
  }
  // Once daily hotel candidates exist, the candidate set is the resource
  // choice. Hotel resolution may later replace the generic display label and
  // description with the first candidate without changing anything submitted
  // to VBK. These derived strings must not invalidate the final approval.
  for (const day of days) {
    if (!Array.isArray(day.hotelCandidates) || !day.hotelCandidates.length) continue;
    delete day.hotel;
    delete day.hotelDescription;
  }
  return createHash('sha256').update(JSON.stringify(canonical(data))).digest('hex');
}

export function approvedPlanVersion(product: Pick<ProductDetail, "product">): string {
  const data = structuredClone(product.product);
  delete data.diagnostics;
  return legacyProductVersion({ product: data });
}
