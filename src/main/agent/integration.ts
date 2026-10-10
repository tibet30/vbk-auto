/**
 * agent/integration 入口（barrel）：
 *   - util.ts：JsonObject / productData / cleanText / safeJson / requirePatch /
 *     positiveInteger / absentTravelNodeResearchTask / applyResolvedItineraryHotels
 *     / selectItinerarySpot / clearUnverifiedItineraryPois；
 *   - tools.ts：createAgentBusinessTools（生成 + 草稿 + 创建恢复三组子工具 +
 *     各业务侧 query_* / select_* / resolve_* / read_* 工具 + 互斥锁包装）。
 *
 * 同时 re-export：
 *   - agentProductVersion（integration-gates）
 *   - hasCompletePresentationRecommendations + AgentBusinessDependencies（integration-generate）
 *   - persistedItineraryHotelResult（integration-itinerary-hotel-result）
 */

export { agentProductVersion } from "./integration-gates.js";
export {
  hasCompletePresentationRecommendations,
  type AgentBusinessDependencies,
} from "./integration-generate.js";
export { persistedItineraryHotelResult } from "./integration-itinerary-hotel-result.js";

export {
  JsonObject,
  productData,
  cleanText,
  safeJson,
  requirePatch,
  positiveInteger,
  absentTravelNodeResearchTask,
  applyResolvedItineraryHotels,
  selectItinerarySpot,
  clearUnverifiedItineraryPois,
} from "./integration/util.js";
export { createAgentBusinessTools } from "./integration/tools.js";