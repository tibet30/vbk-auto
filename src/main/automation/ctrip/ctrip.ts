/**
 * ctrip 自动化阶段公开 API 聚合 re-export：
 *   - sale-control / tabs / basic-info API / presentation / terms / screenshot；
 *   - 保持原有导入路径兼容，外部代码只需 `import { fillAndSaveBasicInfo, ... } from "../ctrip/ctrip.js"`。
 *
 * 顶部带 `// @ts-nocheck`，是单一聚合层不做类型校验。
 *
 * 历史说明：
 *   - `fillItineraryDraft` 旧 DOM 路径已被弃用，聚合层不再导出；
 *     主路径 / 单阶段重跑 / debug 都直接走
 *     `../ctrip/itinerary/api-entry.js` 的 `fillItineraryDraftApi`。
 */

export { inspectProductList, configureProductShell, createProductShell } from "./sale-control/sale-control.js";
export { ensureBasicInfoApi, getProductBaseInfoApi } from "./basic-info/api.js";
export {
  selectCtripLibraryImage,
  fillAndSavePresentation,
  buildRecommendationReasonsPlan,
} from "./presentation/presentation.js";
export { fillAndSaveTerms } from "./terms.js";
export { saveScreenshot } from "./screenshot.js";
export type { RecommendationPlanStep } from "./presentation/presentation.js";
export { PRODUCT_IMAGE_TEXT_PATH } from "./basic-info/basic-info.js";
