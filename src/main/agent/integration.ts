/**
 * agent/integration 入口（barrel）：
 *   - util.ts：JsonObject / productData / cleanText / safeJson / requirePatch /
 *     positiveInteger / absentTravelNodeResearchTask
 *     / selectItinerarySpot / clearUnverifiedItineraryPois；
 *   - tools.ts：createAgentBusinessTools（生成 + 草稿 + 创建恢复三组子工具 +
 *     各业务侧 query_* / select_* / resolve_* / read_* 工具 + 互斥锁包装）。
 *
 * 同时 re-export：
 *   - agentProductVersion（integration-gates）
 *   - hasCompletePresentationRecommendations + AgentBusinessDependencies（integration-generate）
 */

export { agentProductVersion } from "./integration-gates.js";
export {
  hasCompletePresentationRecommendations,
  type AgentBusinessDependencies,
} from "./integration-generate.js";

export {
  productData,
  cleanText,
  safeJson,
  requirePatch,
  positiveInteger,
  absentTravelNodeResearchTask,
  selectItinerarySpot,
  clearUnverifiedItineraryPois,
} from "./integration/util.js";
export type { JsonObject } from "./integration/util.js";
export { createAgentBusinessTools } from "./integration/tools.js";
