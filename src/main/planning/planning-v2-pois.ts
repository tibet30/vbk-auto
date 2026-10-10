/**
 * 规划 v2 POI 解析 + 行程展开（barrel）：
 *   - resolvePlanningPoiCandidates：re-export 自 planning-poi-resolver.js，
 *     把用户意图 → suggestPoi → 候选池 + 解析；
 *   - toPlanningCandidate：单条 suggestPoi 详情 → PlanningPoiCandidate 收敛；
 *   - expandVerifiedItinerary：把 draft + pool 折成最终 VBK itinerary。
 *
 * 子文件分工：
 *   - aliases.ts：行政地名同义 / 归一 / 键集 / 类型识别；
 *   - location-metadata.ts：POI 地域元数据解析 + 匹配；
 *   - to-planning-candidate.ts：suggestPoi 详情 → PlanningPoiCandidate；
 *   - day-builder.ts：单日展示 / 描述 / 用餐辅助 + 折返检测；
 *   - expand-itinerary.ts：expandVerifiedItinerary 主流程。
 *
 * 配套测试：test/planning/planning-v2-pois.test.ts
 *   - 地域匹配 / 行政词归一 / 单日同城 / 跨日折返 / 用户备选必须连续 等。
 */

export { resolvePlanningPoiCandidates } from "./planning-poi-resolver.js";
export { ADMINISTRATIVE_ALIASES, administrativeType, locationKeys, normaliseLocation } from "./planning-v2-pois/aliases.js";
export { readLocationMetadata, locationMatches } from "./planning-v2-pois/location-metadata.js";
export { toPlanningCandidate } from "./planning-v2-pois/to-planning-candidate.js";
export { expandVerifiedItinerary } from "./planning-v2-pois/expand-itinerary.js";