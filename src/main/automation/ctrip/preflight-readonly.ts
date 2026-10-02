import { buildReadbackExpectations } from "./itinerary-api/itinerary-transform.js";
import { enrichItineraryPoiMetadata } from "./itinerary-api/poi-metadata.js";
import { verifyItineraryReadback } from "./itinerary-api/readback.js";
import { resolveStationsForItinerary } from "./itinerary-api/stations-resolver.js";
import { runProductPreflightApi } from "./preflight-api.js";

/**
 * Recovery readback must use the same POI ticket semantics as itinerary save:
 * locally omitted ticketType is resolved from suggestPoi before expectations
 * are built.  The helper performs query-only suggestPoi calls.
 */
export async function buildReadOnlyItineraryReadbackExpectations(
  page: any,
  product: any,
  stations: any,
) {
  const itinerary = Array.isArray(product?.itinerary) ? product.itinerary : [];
  const operations = product?.operations ?? {};
  const enrichedItinerary = await enrichItineraryPoiMetadata(page, itinerary);
  return buildReadbackExpectations({ itinerary: enrichedItinerary, operations, stations });
}

/**
 * The recovery-only preflight strengthens normal module checks with a complete
 * itinerary field readback and canonical re-resolution of station codes. It is
 * read-only: each imported helper issues only GET/SOA query operations.
 */
export async function runProductReadOnlyPreflightApi(
  page: any,
  product: any,
  productId: string,
  options: { itineraryTourInfoId?: string } = {},
) {
  if (!options.itineraryTourInfoId) throw new Error("只读恢复预检必须指定已验证的 draft 行程 ID。");
  const base = await runProductPreflightApi(page, product, productId, options);
  const operations = product?.operations ?? {};
  const pickupCity = typeof operations.pickupCity === "string" ? operations.pickupCity.trim() : "";
  if (!pickupCity) throw new Error("只读预检缺少 operations.pickupCity，不能证明接送站与行程一致。");
  const endpointPlan = operations?.trafficLine?.availability?.endpointPlan;
  const stations = await resolveStationsForItinerary(page, {
    pickupCity,
    dropoffCity: typeof operations.dropoffCity === "string" ? operations.dropoffCity.trim() : undefined,
    endpointPlan,
  });
  const expectations = await buildReadOnlyItineraryReadbackExpectations(page, product, stations);
  const detail = await verifyItineraryReadback(page, options.itineraryTourInfoId, expectations);
  return { ...base, itinerary: { ...base.itinerary, verifiedFields: detail } };
}
