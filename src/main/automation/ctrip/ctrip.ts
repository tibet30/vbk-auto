// @ts-nocheck

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
