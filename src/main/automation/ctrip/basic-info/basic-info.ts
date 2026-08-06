// @ts-nocheck
// 基本信息页（baseInfoMerge）：包括省市、产品线、400 电话、景点、提前预订、
// 地接社、管家联系人等垂直领域；以及 fillAndSaveBasicInfo 顶层的"保存+下一步"。

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
export { isProductImageTextUrl } from "../tabs.js";
export { fillById } from "../utils.js";
