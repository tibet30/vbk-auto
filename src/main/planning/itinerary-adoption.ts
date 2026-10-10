/**
 * itinerary-adoption 入口（barrel）：
 *   - fingerprint.ts：itineraryFingerprint（sha256 JSON 24 字符 hex）；
 *   - utils.ts：节点集合（COMPLETION_NODES / ITINERARY_NODES / HOTEL_RESOLUTION_NODE
 *     / SETTLEMENT_NODE_NAMES）+ invalidateItineraryNode + asRecord / text /
 *     positiveInteger / normaliseMentionText；
 *   - state-types.ts：RequiredItinerarySpot + ItineraryAdoptionGuard；
 *   - state.ts：markItineraryPendingAdoption / markItineraryVerifying /
 *     markItineraryBlocked / markItineraryAccepted + hasPendingItineraryAdoption +
 *     isPlanningRunInProgress + guardLatestItineraryAdoption；
 *   - spots.ts：collectRequiredItinerarySpots / isTravelNodeName / applyPoiMatches /
 *     applyUnmatchedPoiSourcePolicy / findUserRecommendedSpotNames /
 *     itineraryHasRequiredPois。
 */

export {
  COMPLETION_NODES,
  HOTEL_RESOLUTION_NODE,
  ITINERARY_NODES,
  SETTLEMENT_NODE_NAMES,
  asRecord,
  invalidateItineraryNode,
  normaliseMentionText,
  positiveInteger,
  text,
} from "./itinerary-adoption/utils.js";
export { itineraryFingerprint } from "./itinerary-adoption/fingerprint.js";
export type { RequiredItinerarySpot, ItineraryAdoptionGuard } from "./itinerary-adoption/state-types.js";
export {
  markItineraryPendingAdoption,
  markItineraryVerifying,
  markItineraryBlocked,
  markItineraryAccepted,
  hasPendingItineraryAdoption,
  isPlanningRunInProgress,
  guardLatestItineraryAdoption,
} from "./itinerary-adoption/state.js";
export {
  collectRequiredItinerarySpots,
  isTravelNodeName,
  applyPoiMatches,
  applyUnmatchedPoiSourcePolicy,
  findUserRecommendedSpotNames,
  itineraryHasRequiredPois,
} from "./itinerary-adoption/spots.js";