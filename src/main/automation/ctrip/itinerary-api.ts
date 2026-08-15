/**
 * itinerary-api.ts：行程阶段 soa2 主接口保存层的 barrel（公开导出兼容）。
 *
 *   - 实际实现拆为以下模块：
 *     - ./itinerary-api/transport.ts      soa2 端点 / Ack 归一化 / postSoa 通用包装；
 *     - ./itinerary-api/steps.ts          6 个 step 的最小包装（fetch / check / save）；
 *     - ./itinerary-api/stations-resolver.ts 接送站解析（pickAirport / pickTrain / resolveStationsForCity）；
 *     - ./itinerary-api/readback.ts       字段级回读校验（verifyItineraryReadback）；
 *     - ./itinerary-api/orchestrator.ts   主入口（ensureItineraryApi / countItineraryApiSpots）。
 *
 *   - 所有公开符号（包括兼容性入口 ensureItinerarySpotsApi）都从这里 re-export；
 *     外部仍可 `import { ensureItineraryApi, countItineraryApiSpots, ... } from
 *     "../ctrip/itinerary-api.js"`，无需修改调用方。
 *
 * 设计要点：
 *   - 完全基于真实 soa2 接口契约，不依赖 VBK tourdays 页面 DOM；
 *   - DOM 仅保留「提交审核并下一步」做导航 / 进入套餐管理（由 itinerary/api-entry.ts 负责）；
 *   - 接送站搜索委托给 station-search（真实接口）；
 *   - 入参 product 必须是 parseProduct() 之后的归一化形状。
 */

export {
  GET_TOUR_INFO_LIST_URL,
  GET_TOUR_DAILY_URL,
  CHECK_TOUR_DAILY_URL,
  CALC_TOUR_SCORE_URL,
  SAVE_TOUR_DAILY_URL,
  SAVE_TOUR_INFO_URL,
  SOHEAD,
  statusAck,
  describeAckError,
  postSoa,
  type ApiPage,
  type AckKind,
  type PostSoaOptions,
  type ItineraryApiResult,
} from "./itinerary-api/transport.js";

export {
  pickAirport,
  pickTrain,
  resolveStationsForCity,
} from "./itinerary-api/stations-resolver.js";

export {
  verifyItineraryReadback,
  type VerifyReadbackSummary,
} from "./itinerary-api/readback.js";

export {
  ensureItineraryApi,
  ensureItinerarySpotsApi,
  countItineraryApiSpots,
} from "./itinerary-api/orchestrator.js";
