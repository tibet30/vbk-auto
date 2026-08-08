/**
 * 行程描述页（tourdays）：每日标题、餐饮、酒店、接送站、其他节点。
 *
 * 包括 fillItineraryDraft 顶层的"提交审核并下一步"以及「请选择机场/火车站」 modal。
 *
 * 本文件是聚合 re-export：实际实现分散到 stations / cards / common / main。
 */

export {
  dayScopeFor,
  ensureOtherCard,
  ensureServiceTimeRange,
  clickExact,
  clickByCandidates,
  cardsByPrefix,
  clickLabelExact,
  ensureCheckboxChecked,
} from "./common.js";
export {
  fillMealCards,
  fillHotelCard,
} from "./cards.js";
export {
  selectStationAddress,
  fillPickupAndDropoff,
  handleAirportTrainModal,
} from "./stations.js";
export { fillItineraryDraft } from "./main.js";
