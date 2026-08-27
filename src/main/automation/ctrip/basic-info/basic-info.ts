/**
 * 基本信息页（baseInfoMerge）：包括省市、产品线、400 电话、景点、提前预订、
 * 地接社、管家联系人等垂直领域；以及 fillAndSaveBasicInfo 顶层的"保存+下一步"。
 *
 * 本文件是聚合 re-export：实际实现分散到 types / location / scenic / sections / core / main。
 */

export { PRODUCT_IMAGE_TEXT_PATH } from "./types.js";
export { pickCityOption } from "./types.js";
export {
  fillCitySelect,
  fillProductLine,
} from "./location.js";
export { fillScenicAreaProvince, fillScenicAreaSpots } from "./scenic.js";
export {
  fillServicePhone,
  fillAdvanceBooking,
  fillLocalTravelAgency,
  fillButlerContact,
} from "./sections.js";
export { fillBasicInfo, assertBasicInfoNoRedErrors } from "./core.js";
export { fillAndSaveBasicInfo } from "./main.js";
export { syncSupplierProductCode } from "./supplier-product-code.js";
export { isProductImageTextUrl } from "../tabs.js";
export { fillById } from "../utils.js";
