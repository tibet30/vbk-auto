/**
 * 产品草稿归一化（barrel）。
 *
 * AI 输出、外部导入、数据库启动迁移都会先把产品对象喂给 `normaliseProductDraft`，
 * 再让上层继续使用；目的是把不合法字段静默剔除、把别名/缺字段归位到白名单。
 *
 * 几个常被踩到的坑：
 *   - release 默认是草稿安全状态（`safeRelease` 不传 → 保留人工/VBK 打开的开关）；
 *   - 酒店档次遇到旧的 "-5" 会被纠正到 "-38"；
 *   - itinerary 推荐语的三条强制走白名单 + 去重。
 *
 * 主要导出：
 *   - normaliseProductDraft：顶层入口；深拷贝 + 逐字段归一化
 *   - normalisePresentation / normaliseItinerary：presentation / itinerary 子结构归一化
 *   - NormaliseReleaseOptions / NormaliseOptions：safeRelease 选项
 *
 * 子模块：
 *   - helpers.ts     textValue / positiveNumberValue / positiveIntegerValue / normalisePoiId / positiveNumber / positiveInteger；
 *   - presentation.ts  normalisePresentation + normaliseCover / normaliseRecommendations / normaliseRecommendationItem；
 *   - itinerary.ts     normaliseItinerary + normaliseMeals / normaliseHotelCandidates；
 *   - commercial.ts    normaliseCommercialPricing / normaliseCommercialInventory / normaliseCommercialRelease；
 *   - types.ts         NormaliseReleaseOptions / NormaliseOptions；
 *   - top.ts           normaliseProductDraft。
 */

export { positiveNumber } from "./product-normalize/helpers.js";
export type { NormaliseReleaseOptions, NormaliseOptions } from "./product-normalize/types.js";
export { normalisePresentation } from "./product-normalize/presentation.js";
export { normaliseItinerary } from "./product-normalize/itinerary.js";
export { normaliseProductDraft } from "./product-normalize/top.js";