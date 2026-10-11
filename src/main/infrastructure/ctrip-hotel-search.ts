/** Stable hotel resource API. Provider, matching policy and progress projection live separately. */
export { CTRIP_HOTEL_SUGGEST_ENDPOINT, buildHotelListUrl, nextHotelSearchDates,
  fetchCtripHotelContext, readCtripHotelCandidates, fetchCtripHotelCandidates } from "./ctrip-hotel-search/provider.js";
export { selectCtripHotelContext } from "./ctrip-hotel-search/context.js";
export { resolveHotelCandidates as resolveItineraryHotelCandidates } from "./ctrip-hotel-search/resolve.js";
export { shouldResolveItineraryHotelForDay, hotelAnchorNameForDay, hotelSearchContextCityForDay,
  hotelSearchAnchorNames, limitItineraryHotelStays } from "./ctrip-hotel-search/itinerary-policy.js";
export { HOTEL_RESOURCE_CANDIDATE_COUNT } from "../../shared/hotel-candidate-counts.js";
export { extractCtripHotelListFromHtml, hotelCandidatesForTier } from "./ctrip-hotel-list-parser.js";
