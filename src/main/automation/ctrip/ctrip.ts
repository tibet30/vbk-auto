/**
 * ctrip 自动化阶段公开 API 聚合 re-export：
 *   - sale-control / tabs / basic-info / presentation / itinerary / package / pricing
 *     / resources / publish / screenshot / utils / sale-control.workflow；
 *   - 保持原有导入路径兼容，外部代码只需 `import { fillAndSaveBasicInfo, ... } from "../ctrip/ctrip.js"`。
 *
 * 顶部带 `// @ts-nocheck`，是单一聚合层不做类型校验。
 */

export { inspectProductList, configureProductShell, createProductShell } from "./sale-control/sale-control.js";
export {
  clickSection,
  waitForSectionEnabled,
  clickSafeSave,
  submitCurrentSectionAndNext,
  saveThenAdvance,
  isProductImageTextUrl,
  openProductEditor,
  ensureBasicInfoTabVisible,
} from "./tabs.js";
export {
  fillAndSaveBasicInfo,
  fillBasicInfo,
  fillCitySelect,
  pickCityOption,
  fillProductLine,
  fillScenicAreaProvince,
  fillServicePhone,
  fillScenicAreaSpots,
  fillAdvanceBooking,
  fillLocalTravelAgency,
  fillButlerContact,
  assertBasicInfoNoRedErrors,
  fillById,
} from "./basic-info/basic-info.js";
export {
  selectCtripLibraryImage,
  fillRecommendationReasons,
  fillAndSavePresentation,
  buildRecommendationReasonsPlan,
} from "./presentation/presentation.js";
export { selectStationAddress, fillItineraryDraft } from "./itinerary/itinerary.js";
export { fillAndSavePackage } from "./package.js";
export {
  fillAndSubmitPricingInventory,
  fillAndSaveTerms,
} from "./pricing.js";
export {
  ensureHotelResource,
  ensureVehicleResource,
} from "./resources.js";
export {
  runProductPreflight,
  submitProductReview,
  publishProduct,
  auditPublishedProduct,
} from "./publish.js";
export { saveScreenshot } from "./screenshot.js";
export type { RecommendationPlanStep } from "./presentation/presentation.js";
export { PRODUCT_IMAGE_TEXT_PATH } from "./basic-info/basic-info.js";
