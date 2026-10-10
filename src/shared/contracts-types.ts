/**
 * 共享类型契约（核心 umbrella）barrel。
 *
 * 本文件不持有具体类型：内容按"职责"拆分到 `./contracts-types/` 子目录。
 * 历史 importer（45 个文件）继续 `import {...} from "../contracts-types.js"`，
 * 符号由这里再聚合出去。
 *
 * 子模块分工：
 *   - workflow.ts          一键创建后台任务状态机；
 *   - conversation.ts      对话 / 研究任务 / 证据 + 通用 TaskStatus / FieldState；
 *   - product.ts           产品契约：列表 / 详情 / 创建入参 / readiness；
 *   - poi-suggest.ts       VBK / 携程 suggestPoi 抓取契约；
 *   - advisor.ts           AI 顾问失败重试状态机；
 *   - automation.ts        AutomationRun 检查点 + recovery + trafficLine；
 *   - disambiguate.ts      AI 歧义消除（kind=province/city/spot/station）；
 *   - manual-review.ts     运营人工录入白名单（ManualReviewFieldInput discriminated union）；
 *   - vehicle-resource.ts  用车 / 酒店资源匹配结果；
 *   - ai-response.ts       通用 AI 响应包装；
 *   - itinerary.ts         行程 spot / day 形状。
 *
 * 此外 `./contracts-settings`、`./contracts-ctrip-cover`、`./contracts-vbk-account`、
 * `./contracts-operation-log`、`./contracts-memory` 是同层级的"独立契约"，原本
 * 直接被该 barrel `export * from` 转发，本文件保留同样的转发语义。
 */

export type {
  ProductWorkflowTask,
  ProductWorkflowTaskStatus,
  ProductWorkflowTaskStage,
} from "./contracts-types/workflow.js";

export type {
  FieldState,
  TaskStatus,
  ConversationMessage,
  Evidence,
  ResearchTask,
} from "./contracts-types/conversation.js";

export type {
  ProductSummary,
  CreateProductInput,
  ProductReadiness,
  ProductDetail,
} from "./contracts-types/product.js";

export type {
  PoiSuggestLogContext,
  PoiSuggestion,
  PoiSuggestTextField,
  PoiSuggestCandidate,
  PoiSuggestDetailResult,
} from "./contracts-types/poi-suggest.js";

export type {
  AdvisorAction,
  AdvisorRequest,
  AdvisorOutcome,
  RecoveryState,
  PhaseAttempt,
  PhaseRecovery,
} from "./contracts-types/advisor.js";

export type { AutomationRun } from "./contracts-types/automation.js";

export type {
  DisambiguateRequest,
  DisambiguateOutcome,
} from "./contracts-types/disambiguate.js";

export type {
  ManualReviewFieldInput,
  AiRegenerateField,
} from "./contracts-types/manual-review.js";

export type {
  VehicleResourceMatch,
  CtripHotelCandidate,
  CtripHotelResourceDayMatch,
  HotelResourceMatch,
} from "./contracts-types/vehicle-resource.js";

export type { AiResponse } from "./contracts-types/ai-response.js";

export type {
  ItineraryActivityKind,
  ItinerarySpot,
  ItineraryDay,
} from "./contracts-types/itinerary.js";

// 转发同层级"独立契约"文件（保持原 export * 语义）。
export * from "./contracts-settings.js";
export * from "./contracts-ctrip-cover.js";
export * from "./contracts-vbk-account.js";
export * from "./contracts-operation-log.js";
export * from "./contracts-memory.js";