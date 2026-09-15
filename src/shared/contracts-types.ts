import type { CtripLibraryCoverAlternate, ProductCover } from "./contracts-ctrip-cover.js";
import type { ContactCardSelection } from "./contracts-vbk-account.js";

export type FieldState =
  | "proposed"
  | "researching"
  | "resolved"
  | "needs_confirmation"
  | "confirmed"
  | "blocked";

export type TaskStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export type ProductWorkflowTaskStatus =
  | "queued"
  | "running"
  | "needs_attention"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "abandoned";

export type ProductWorkflowTaskStage =
  | "queued"
  | "planning"
  | "readiness"
  | "automation"
  | "completed";

/** 一键创建的持久化后台任务。它独立于 renderer 生命周期，以产品为跳转主体。 */
export interface ProductWorkflowTask {
  id: string;
  localProductId: string;
  productName: string;
  status: ProductWorkflowTaskStatus;
  stage: ProductWorkflowTaskStage;
  progress: number;
  message: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
}

export interface ProductSummary {
  id: string;
  name: string;
  status: "planning" | "review" | "automating" | "draft_saved" | "blocked";
  productId?: string;
  /** 创建该产品时使用的 VBK 登录账号（例如 vbk_671205）。 */
  vbkAccount?: string;
  updatedAt: string;
  revision?: number;
  /** 本机最近一条一键创建任务；不写入 Tibet 产品业务快照。 */
  workflowTask?: ProductWorkflowTask;
}

export interface CreateProductInput {
  destination: string;
  days: number;
  productForm: import("./product-form.js").ProductForm;
  /** 创建产品时用户提供的原始想法，供后续 AI 规划参考。 */
  userIdea?: string;
  /** 勾选后由主进程完成生成、核验和 VBK 自动录入，不依赖 renderer 持续在线。 */
  autoConfirm?: boolean;
}

export interface ProductReadiness {
  ready: boolean;
  completion: number;
  issues: Array<{ label: string; detail: string }>;
}

export interface PoiSuggestLogContext {
  localProductId: string;
  dayIndex: number;
  spotIndex: number;
  title: string;
  destinationCity?: string;
  province?: string;
}

export interface PoiSuggestion {
  poiName: string;
  poiId: number;
}

export interface PoiSuggestTextField {
  path: string;
  value: string;
}

export interface PoiSuggestCandidate {
  index: number;
  poiName: string | null;
  poiId: number | null;
  province?: string | null;
  city?: string | null;
  district?: string | null;
  address?: string | null;
  selectable: boolean;
  textFields: PoiSuggestTextField[];
}

export interface PoiSuggestDetailResult {
  httpStatus: number;
  businessStatus: string | number | boolean | null;
  poiListCount: number;
  best: PoiSuggestion | null;
  candidates: PoiSuggestCandidate[];
}

export interface ProductDetail extends ProductSummary {
  product: Record<string, unknown>;
  messages: ConversationMessage[];
  researchTasks: ResearchTask[];
  automation?: AutomationRun;
  /** 本地 product_json 乐观并发版本；崩溃恢复后用于拒绝过期整包覆盖。 */
  productJsonVersion?: number;
  /** 基本信息是否已在 VBK 成功保存，决定重试时是否需要补跑 basic 阶段。 */
  basicInfoSaved?: boolean;
  planning?: import("./contracts-planning.js").PlanningPlanV2;
  /** 产品级 AI Token 用量；与 planning 同级，权威在 Tibet，不进 product JSON。 */
  aiUsage?: import("./contracts-ai-usage.js").ProductAiUsage;
}

export interface ConversationMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  createdAt: string;
  taskStatus?: TaskStatus;
}

export interface ResearchTask {
  id: string;
  label: string;
  type: "vbk" | "web" | "cost" | "image";
  status: TaskStatus;
  state: FieldState;
  detail?: string;
  evidence?: Evidence[];
}

export interface Evidence {
  id: string;
  title: string;
  url?: string;
  source: "vbk" | "web" | "user";
  retrievedAt: string;
  accepted: boolean;
}

export type AdvisorAction =
  | "retry_same_phase"
  | "reload_and_retry_phase"
  | "reopen_editor_and_retry_phase"
  | "wait_for_user";

export interface AdvisorRequest {
  phase: string;
  attempt: number;            // 1..3
  error: string;              // 已脱敏
  productIdExists: boolean;
  basicInfoSaved: boolean;
  completedPhases: string[];
  diagnosisHistory: Array<{
    summary: string;
    rootCause: string;
    action: AdvisorAction;
    expectedEvidence: string;
  }>;
}

export interface AdvisorOutcome {
  summary: string;
  rootCause: string;
  action: AdvisorAction;
  expectedEvidence: string;
  userInstruction?: string;
}

export type RecoveryState =
  | "running"
  | "advising"
  | "retrying"
  | "needs_user"
  | "completed";

export interface PhaseAttempt {
  attempt: number;
  error: string;
  diagnosis?: { summary: string; rootCause: string; expectedEvidence: string };
  action?: AdvisorAction;
  at: string;                 // ISO timestamp
}

export interface PhaseRecovery {
  phase: string;
  state: RecoveryState;
  attempts: PhaseAttempt[];
  /** 上一轮未完成（needs_user）后被重新进入 phase 时，老的 attempts 会被
   *  归档到这里，rec.attempts 仅保留当前轮的 attempt；渲染时应合并显示。 */
  attemptsHistory?: PhaseAttempt[];
  userInstruction?: string;
  finalError?: string;
}

export interface AutomationRun {
  id: string;
  status: TaskStatus;
  currentPhase?: string;
  phases: Array<{ phase: string; status: "pending" | "running" | "completed" | "failed" }>;
  logs: Array<{ at: string; message: string; level: "info" | "warning" | "error" }>;
  screenshot?: string;
  recovery?: { phases: Record<string, PhaseRecovery> };
  /** 线路及交通仅保存已由远端回读确认的子产品检查点。 */
  trafficLine?: import("./contracts-traffic-line.js").TrafficLineWorkflowProgress;
}

/**
 * AI 歧义消除：在 VBK 下拉里选不到精确项时，把候选项列表发给 AI（默认 MiniMax，
 * 设置里可切换到 Evolink），让它选一个最像的（或者明确表示「无匹配」）。用在
 * 景区、景点、城市、车站等所有严格选择场景下。
 */
export interface DisambiguateRequest {
  /** 上下文类别 — 用在不同 prompt 约束。 */
  kind: "province" | "city" | "spot" | "station";
  /** 仅 kind=station 使用：区分本次候选来自机场框还是火车站框。 */
  stationSubtype?: "airport" | "train";
  /** 产品 JSON 中期望选中的原始值（可能是“太原”“云冈石窟”这种）。 */
  desired: string;
  /** 产品完整 JSON，供 AI 理解上下文。 */
  product: Record<string, unknown>;
  /** VBK 下拉返回的全部候选（包含中文 / ID / 中文别名）。 */
  candidates: Array<{ id?: string; text: string }>;
}

export interface DisambiguateOutcome {
  /** 选中的候选项 text，未选中返回 null。 */
  pickedText: string | null;
  /** 模型对本次选择的置信度，范围为 0 到 1。 */
  confidence: number;
  /** AI 的判断理由（给人看）。 */
  reasoning: string;
}

export * from "./contracts-settings.js";

/**
 * 运营人员在 review 面板上对单个字段的人工录入白名单。
 *
 * 用 discriminator (`field`) 拆分，每种 case 只覆盖一类字段，避免一个
 * 巨型 payload 把无关字段都拖进来。落地前 main 进程会再用 productSchema
 * 校验一次完整 product，保证无关字段保持原状。
 */

export * from "./contracts-ctrip-cover.js";

export type ManualReviewFieldInput =
  | { field: "pricing"; adult: number; child: number; minimumTravelers: number }
  | { field: "inventory"; startDate: string; endDate: string; dailyQuota: number }
  /** 副标题：写入 basicInfo.subtitle。 */
  | { field: "basicInfoSubtitle"; subtitle: string }
  /** 用车资源组人工复核只允许写全程预计总成本；真实资源组 ID / 名称由 VBK 匹配回填。 */
  | { field: "vehicleResource"; requestedTotalCost?: number | null }
  /** 每日行程 spot 的 VBK POI 手动补全：写入指定 spot 的 poiName / poiId，以及可选行政区。 */
  | {
    field: "itinerarySpotPoi";
    dayIndex: number;
    spotIndex: number;
    poiName: string;
    poiId: number;
    province?: string | null;
    city?: string | null;
    district?: string | null;
  }
  /** 每日行程 spot 手动删除：只移除指定 spot，并同步移除同名 visit 活动。 */
  | { field: "itinerarySpotRemove"; dayIndex: number; spotIndex: number }
  /**
   * 管家联系人：来自账号固定信息 (AccountFixedInfo.butlerName)，
   * 必须是合法的 ContactCardSelection（contactCardId / providerId / displayName）。
   * selection === null 表示清空（让自动化阶段走 VBK 默认逻辑）。
   */
  | { field: "butlerContact"; selection: ContactCardSelection | null }
  /**
   * 产品封面：ctripLibrary / manualUpload 两种形态。cover 形态由 cover.source
   * 决定：ctripLibrary 以 poi 与已选图片为准，description/minQuality 可选；manualUpload 额外含
   * fileId/originalName/mimeType/sizeBytes/uploadedAt，且 fileId 必须先经
   * main 端 cover:uploadManual 写入本地副本。
   *
   * 类型定义在下方：`CtripLibraryCover` / `ManualUploadCover`；它们与
   * `ProductCover` discriminated union 共享 source 字段，避免同时维护两套
   * 形状。
   */
  | {
      field: "productCover";
      cover: ProductCover;
    };

/**
 * AI 单字段重新生成允许的目标字段。当前 main 端只把这条 IPC 当作「未发布」
 * 占位（抛错），但 contracts 类型保留以便后续接入。
 */
export type AiRegenerateField = "subtitle" | "province" | "operationNotes" | "pricing" | "itinerary" | "sellingPoints";

export interface VehicleResourceMatch {
  query: string;
  city: string;
  days: number;
  totalCost?: number;
  resourceGroupId: number;
  resourceGroupName: string;
}

export interface HotelResourceMatch {
  source: "vbk" | "ctrip" | "nonPlatform";
  resourceId?: number;
  resourceName: string;
  supplierCode?: string;
  roomType?: string;
  query?: string;
  dailyCandidates?: CtripHotelResourceDayMatch[];
}

/** 已由携程酒店列表验证的行程住宿候选；hotelId 是后续资源配置的唯一锚点。 */
export interface CtripHotelCandidate {
  hotelId: number;
  hotelName: string;
  diamond: number;
  score: number;
  distanceKm: number;
  address?: string;
  cityName: string;
  anchorName: string;
  anchorCityId: number;
}

export interface CtripHotelResourceDayMatch {
  day: number;
  candidates: CtripHotelCandidate[];
}

export * from "./contracts-vbk-account.js";

export interface AiResponse {
  reply: string;
  patch?: Array<{ op: "add" | "replace" | "remove"; path: string; value?: unknown }>;
  questions?: string[];
  researchTasks?: Array<Pick<ResearchTask, "label" | "type" | "detail">>;
}

export * from "./contracts-operation-log.js";
export interface ItinerarySpot {
  name: string;
  poiName: string | null;
  poiId: number | null;
  province?: string | null;
  city?: string | null;
  district?: string | null;
  /** 同一时段景点关系：and=全部参观；or=同组多选一。缺省按 and 处理。 */
  relation?: "and" | "or";
  timeOfDay?: "morning" | "afternoon";
  /**
   * 携程图库抓图时，封面用满（最多 10 张）后剩余图按 POI 归属写入对应景点。
   * 匹配规则：candidate.poiId === spot.poiId 优先；否则 candidate.poiName 与
   * spot.name / spot.poiName 互含。
   * 每个 spot 最多保留 10 张（与封面口径一致），按搜索返回顺序保留前 N 张；
   * 已经写进 presentation.cover 的 imageId 不会重复落到这里。
   */
  images?: CtripLibraryCoverAlternate[];
}
export interface ItineraryDay { day: number; title: string; spots?: ItinerarySpot[]; description: string; hotel: string; meals: string }

export * from "./contracts-memory.js";
