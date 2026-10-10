/**
 * tourDailyInfo 各节点构造器（barrel）：
 *   - 每个 builder 返回的形状都与"真实 detail 抓回"一致，避免平台校验因字段
 *     缺失而拒绝；
 *   - 共用字段（takeoffTime / takeoffEndTime / activeType / costInclude 等）从
 *     commonInfoFields 拿，确保节点间字段对齐；
 *   - buildAttractionPois 在 poiId / poiName 缺失时直接抛错（业务失败而不是
 *     隐式跳过）；
 *   - refId 一律为 null（真实 detail 样本里 refId 都是 null；不允许伪造字符串）。
 *
 * 子文件分工：
 *   - common.ts：commonInfoFields + otherActivityTime；
 *   - ticket-suffix.ts：attractionTicketSuffix（含 FREE / PAID / EXTERIOR_ONLY 三档）；
 *   - poi.ts：buildAttractionPois；
 *   - hotel.ts：buildHotelInfo + hotelTierPresentation；
 *   - meal.ts：buildMealInfo；
 *   - transport.ts：buildDailyTransportInfo；
 *   - activity.ts：buildPickupInfo + buildDropoffInfo + buildFreeInfo + buildOtherInfo。
 */

export { commonInfoFields, otherActivityTime } from "./info-builders/common.js";
export { attractionTicketSuffix } from "./info-builders/ticket-suffix.js";
export { buildAttractionPois } from "./info-builders/poi.js";
export { buildHotelInfo, hotelTierPresentation } from "./info-builders/hotel.js";
export { buildMealInfo } from "./info-builders/meal.js";
export { buildDailyTransportInfo } from "./info-builders/transport.js";
export { buildPickupInfo, buildDropoffInfo, buildFreeInfo, buildOtherInfo } from "./info-builders/activity.js";