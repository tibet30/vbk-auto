/**
 * 「产品图文」阶段公开 API 聚合 re-export：
 *   - recommend categories / buildRecommendationReasonsPlan / fillRecommendationReasons；
 *   - selectCtripLibraryImage / selectCtripLibraryCover / fillAndSavePresentation；
 *   - 配合内部 main.ts / recommendations.ts 的实现，对外保持稳定导入路径。
 */

export { RECOMMENDATION_CATEGORIES } from "../../schema/schema-definitions.js";
export { buildRecommendationReasonsPlan, fillRecommendationReasons } from "./recommendations.js";
export type { RecommendationPlanStep } from "./recommendations.js";
export {
  selectCtripLibraryImage,
  fillAndSavePresentation,
  selectCtripLibraryCover,
  fillFirstVisible,
  hasCoverImage,
  selectSearchOption,
  type LibraryImageParams,
} from "./main.js";
export { fillProductFeatures, type FeaturesResult } from "./features.js";
