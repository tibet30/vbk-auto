/**
 * itinerary-api/steps 入口（barrel）：
 *   - fetch.ts：fetchTourInfoId / fetchDailyTemplateDetail / fetchTourDailyDetail
 *     + parseTemplateId + DEFAULT_DAILY_TEMPLATE_ID + 三个 result interface；
 *   - save.ts：checkTourDailyStep / calculateTourScoreStep / saveTourDailyDetailStep
 *     / saveProductTourInfoStep。
 *
 * 这些 step 不做任何"业务编排"（不合并 tourInfo、不调接送站、不做回读），
 * 只负责单次请求与响应解析；orchestrator.ts 用它们串起整个流程。
 */

export {
  DEFAULT_DAILY_TEMPLATE_ID,
  fetchTourInfoId,
  fetchDailyTemplateDetail,
  fetchTourDailyDetail,
  parseTemplateId,
  type FetchTourInfoIdResult,
  type FetchDailyTemplateDetailResult,
  type FetchTourDailyDetailResult,
} from "./steps/fetch.js";
export {
  checkTourDailyStep,
  calculateTourScoreStep,
  saveTourDailyDetailStep,
  saveProductTourInfoStep,
} from "./steps/save.js";