/**
 * traffic-line/itinerary.ts barrel：交通线路编辑后端核心 helper。
 *
 * 已有子模块：
 *   - ./itinerary-materialization.js  实际写入 TourInfo 主链路（已切分）；
 *
 * 本 barrel 内聚的子模块：
 *   - traffic-merge.ts                mergeTrafficNodes / verifyTrafficNodes / expectedTrafficKey / replaceIncompleteEdgeTraffic；
 *   - risk-plans.ts                   applyRequiredPoiRiskPlans（必去 POI 强制 costInclude="F"）；
 *   - readback.ts                     readTrafficNodesFromPage + isTrafficNode / isCompleteTrafficNode；
 *   - card-builders.ts                flight / train 包 + legacy 卡构造与补全；
 *   - predicates.ts                   hasFlightCard / hasTrainCard / hasUsablePackage* / hasUsableLegacy* / hasNamedCode。
 */

export { ensureTrafficLineItinerary, waitForTrafficLineItineraryReadback } from "./itinerary-materialization.js";
export type { TrafficLineEndpointPlan } from "../../../../shared/contracts-traffic-line.js";
export type { TrafficLineVariant } from "../../../../shared/contracts-traffic-line.js";
export { currentTrafficLineTourInfoId } from "./itinerary/current-id.js";
export {
  mergeTrafficNodes,
  verifyTrafficNodes,
  expectedTrafficKey,
} from "./itinerary/traffic-merge.js";
export { applyRequiredPoiRiskPlans } from "./itinerary/risk-plans.js";
export {
  readTrafficNodesFromPage,
  isTrafficNode,
  isCompleteTrafficNode,
} from "./itinerary/readback.js";
export {
  finaliseTrafficNode,
  trafficNodeWithRequiredCard,
  flightPackageCard,
  completeFlightPackageCard,
  flightLegacyCard,
  trainNodeWithRequiredCard,
  completeTrainPackageCard,
  trainPackageCard,
  trafficEndpointPlaceholder,
  trainLegacyCard,
} from "./itinerary/card-builders.js";
export {
  hasFlightCard,
  hasTrainCard,
  hasUsablePackageFlight,
  hasUsableLegacyFlight,
  hasUsablePackageTrain,
  hasUsableLegacyTrain,
  hasNamedCode,
} from "./itinerary/predicates.js";