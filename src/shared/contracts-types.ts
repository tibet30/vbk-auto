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
  /** AI 的判断理由（给人看）。 */
  reasoning: string;
}

export type AiProvider = "minimax" | "deepseek";

export interface Settings {
  aiProvider: AiProvider;
  minimaxBaseUrl: string;
  minimaxModel: string;
  deepseekBaseUrl: string;
  deepseekModel: string;
  hasMiniMaxKey: boolean;
  hasDeepSeekKey: boolean;
  dataPath: string;
}

export interface ConnectionTest {
  connected: boolean;
  message: string;
  provider: AiProvider;
  baseUrl: string;
  model: string;
  testedAt: string;
}

export interface AiConnectionTestInput {
  provider: AiProvider;
  baseUrl: string;
  model: string;
  apiKey?: string;
}

export interface AiModelListInput {
  provider: AiProvider;
  baseUrl: string;
  apiKey?: string;
}

export interface AiModelInfo {
  id: string;
  label: string;
  ownedBy?: string;
}

export interface AiModelListResult {
  models: AiModelInfo[];
  fetchedAt: string;
}

/**
 * 运营人员在 review 面板上对单个字段的人工录入白名单。
 *
 * 用 discriminator (`field`) 拆分，每种 case 只覆盖一类字段，避免一个
 * 巨型 payload 把无关字段都拖进来。落地前 main 进程会再用 productSchema
 * 校验一次完整 product，保证无关字段保持原状。
 */

/** 携程图库封面：cover.source === "ctripLibrary"。
 *  - imageId / imageUrl 是「用户在 UI 上选中了一张具体图片」的身份与展示
 *    URL，必须在写入 cover 时一并保存，否则下游无法还原当时选中的图；
 *  - poi / description / minQuality 仍保留给 `selectCtripLibraryCover` 自动化
 *    阶段使用（按 cover.poi 进 VBK 图库弹窗、按 cover.minQuality 兜底过滤）；
 *  - thumbnailUrl / previewUrl / score / resolution 是 getImageInfo 返回的
 *    派生字段，便于 UI 复核与排查；非必填；
 *  - poiId / poiName 是 getImageInfo 返回的"图片所属 POI"，与候选的搜索
 *    POI（candidate.poiId）可能不同；保留便于产物比对；
 *  - selectedAt 是用户在 UI 上选定该图的 ISO 时间戳，便于审计 / 重选；
 *  - 不持有图片二进制，运行时由 fillAndSavePresentation 阶段从 VBK 图库
 *    重新抓取（命中 cover.poi 后做二次确认）。
 */
export interface CtripLibraryCover {
  source: "ctripLibrary";
  /** 携程图库 imageId，正整数；在 UI 上「一张图」的主键。 */
  imageId: number;
  /** 携程图库图片展示 URL（getImageInfo 返回的 thumbnailUrl / previewUrl / originalUrl 之一）。 */
  imageUrl: string;
  poi: string;
  description: string;
  minQuality: number;
  /** 缩略图 URL（200 档），与 imageUrl 不同时保留以便 UI 区分。 */
  thumbnailUrl?: string;
  /** 预览图 URL（500 档），与 imageUrl 不同时保留以便 UI 区分。 */
  previewUrl?: string;
  /** 携程图库图片质量分（noteImgScore / tourImgAiScore）。 */
  score?: number;
  /** 原图分辨率文本，例如 "1280*1917"。 */
  resolution?: string;
  /** getImageInfo 返回的 POI ID（图片所属 POI）。 */
  poiId?: number;
  /** getImageInfo 返回的 POI 名称（图片所属 POI）。 */
  poiName?: string;
  /** UI 上确认选中的时间（ISO 字符串）。 */
  selectedAt?: string;
}

/** 手动上传封面：cover.source === "manualUpload"。
 *  - fileId / originalName / mimeType / sizeBytes / uploadedAt 由 main 端
 *    cover:uploadManual 分配 / 持久化，product JSON 仅保留引用与元数据；
 *  - 真正的图片字节只落本机 covers 目录，绝不写入 product JSON；
 *  - 与 CtripLibraryCover 共享 poi / description / minQuality 字段，方便
 *    UI 通用展示 / 业务代码按 source 分支处理。
 */
export interface ManualUploadCover {
  source: "manualUpload";
  fileId: string;
  originalName: string;
  mimeType: "image/jpeg" | "image/png" | "image/webp";
  sizeBytes: number;
  poi: string;
  description: string;
  minQuality: number;
  uploadedAt: string;
}

/**
 * 手动上传封面在 main 端 covers/cover-meta.json 里持久化的元数据形状。
 * 与 ManualUploadCover 的差别：
 *  - 不含 source / poi / description / minQuality（这些是 product JSON 才有的字段）；
 *  - 是 cover:uploadManual / cover:listManual 等 IPC 返回的稳定类型，独立于
 *    product 上层，便于 renderer / 主流程按"纯存储元数据"使用。
 */
export interface ManualUploadCoverMeta {
  fileId: string;
  originalName: string;
  mimeType: "image/jpeg" | "image/png" | "image/webp";
  sizeBytes: number;
  uploadedAt: string;
}

/** 携程图库查询候选图（main 端查询携程图片库后返回给 UI 的最小信息）。
 *  - stableId / index：stableId 优先用于写回 cover；index 用于回放与排查；
 *  - quality / resolution：用于在 UI 上直接展示 + 业务挑选（findBestCtripLibraryImage）；
 *  - previewUrl / thumbnailUrl / imageUrl：UI 展示 / 写回 product cover 用的
 *    图片 URL；imageUrl 优先于 previewUrl / thumbnailUrl，是写入 cover.imageUrl
 *    的首选，没有时回退 previewUrl / thumbnailUrl / originalUrl；
 *  - imageId / poiId / poiName / score / fileName / districtName / countryName：
 *    与 getImageInfo 拼装后的字段；imageId 缺失时 UI 走「未取到图库图片」错误，
 *    不展示占位；
 *  - imageResolved：true 表示数据来自 getImageInfo 真实解析；false / undefined
 *    表示仅有 DOM 占位（已废弃，新链路只走 getImageInfo）。
 */
export interface CtripLibraryImageCandidate {
  stableId: string;
  index: number;
  quality: string;
  resolution: string;
  /** 写回 cover.imageUrl 的首选 URL；缺失时 UI / 自动降级回 previewUrl / thumbnailUrl / originalUrl。 */
  imageUrl?: string;
  previewUrl?: string;
  thumbnailUrl?: string;
  rawText?: string;
  imageId?: number;
  poiId?: number;
  poiName?: string;
  score?: number;
  fileName?: string;
  districtName?: string;
  countryName?: string;
  /** 来源标识：true = 数据来自 getImageInfo 真实解析。 */
  imageResolved?: boolean;
}

/** 携程图库查询的地点候选（suggestpoi.json → 地址 / 景点列表）。
 *  - poiId / poiName 是 suggestPoi 必填字段，决定后续 searchImage 的 tag；
 *  - address / province / city / district 由 suggestPoi 响应里可读字段抽出，
 *    缺时为 null；UI 用它们展示完整地址行；
 *  - stableId：UI 选中后回传给 main 端「按该 place 取 imageIds」时使用的稳定主键；
 *    形如 `poi:${poiId}`；UI 不要自造；
 *  - index：suggestPoi 响应里的原始顺序（0..N），便于排查与回放；
 *  - rawText：调试用 raw 摘要（poiId + name），不进日志链路。
 */
export interface CtripLibraryPlaceCandidate {
  stableId: string;
  index: number;
  /** suggestPoi 返回的 POI ID；后续 searchImage 的 PoiId 标签值。 */
  poiId: number;
  /** suggestPoi 返回的 POI 名称（景点 / 地址名）。 */
  poiName: string;
  /** 完整地址文本，缺时为 null。 */
  address?: string | null;
  province?: string | null;
  city?: string | null;
  district?: string | null;
  /** 调试用 raw 摘要，IPC 不记日志。 */
  rawText?: string;
}

/** 携程图库地点搜索结果：keyword + places + fetchedAt。
 *  - keyword 是 trim 后的用户输入；
 *  - places 是合法候选（poiId + poiName 都齐备）按 suggestPoi 原始顺序排列；
 *  - candidates-after-dedup / imageIds 等旧字段不保留：阶段 A 不涉及图。
 *  - 错误由查询函数直接抛出（业务失败 / 网络失败 / 鉴权失败等），不在本结构
 *    里表达。
 */
export interface CtripLibraryPlaceSearchResult {
  keyword: string;
  places: CtripLibraryPlaceCandidate[];
  fetchedAt: string;
}

/** 携程图库查询结果：来源输入 + 候选数组。
 *  - source 与 cover.source 同名 ctripLibrary 便于直接喂给 ctripLibrary 写入路径；
 *  - candidates 为空时表示未匹配，UI 需明确告知用户；
 *  - 错误由查询函数直接抛出，不在本结构里表达；
 *  - 当前链路只走 getImageInfo：keyword / poi 字段保留「输入回显」用，
 *    - keyword：用户输入的 imageIds 字符串（逗号 / 空格 / 换行分隔），
 *      方便 UI 不改 stat shape 的前提下看到「我刚搜的是什么 ID」；
 *    - poi：恒为空字符串（不再做地点搜索）。
 *  - callers 仅依赖 candidates / fetchedAt；keyword / poi 是给 UI 渲染 / 调试用。
 */
export interface CtripLibrarySearchResult {
  keyword: string;
  poi: string;
  candidates: CtripLibraryImageCandidate[];
  fetchedAt: string;
}

/** product JSON 中的封面对象总集（discriminated union）。 */
export type ProductCover = CtripLibraryCover | ManualUploadCover;

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
   * 决定：ctripLibrary 仅含 poi/description/minQuality；manualUpload 额外含
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

export interface VbkLoginStatus {
  loggedIn: boolean;
  message: string;
  /** VBK 页面展示名，例如"小璐"。 */
  accountName?: string;
  /** VBK 登录账号，例如"vbk_671205"。 */
  loginAccount?: string;
  accounts?: string[];
}

/**
 * 本机已记录但**当前 WebView 未在线**的 VBK 登录账号。
 *
 * 多账号登录的工作流是这样的：
 *  - WebView 同一时刻只能显示一个账号；
 *  - "新增登录"会把当前账号的 cookies 抽出来存进 settings 表（key = 登录账号）；
 *  - 切到已记录的账号时再把 cookies 回灌到 session。
 *
 * lastUsedAt 只用来给 UI 排序（最近用过靠前），不参与匹配。
 */
export interface SavedLoginAccount {
  /** 唯一标识，VBK 的登录账号（vbk_xxx）/ 真实姓名兜底。这两者要在设置面板看起来一致。 */
  accountKey: string;
  /** 真实展示名（vbk_671205 / 小璐）。与 accountKey 在多数场景下相同，缺时回落 accountKey。 */
  accountName: string;
  /** 最近一次被保存到本机的时间（ISO 字符串），用于排序；已被忘记的账号不会出现在这里。 */
  lastUsedAt: string;
}

/**
 * 列举多账号登录态的合并视图：当前 + 已记录。
 * - `current` 为当前 WebView 实际拿到的账号，可能为空（未登录）。
 * - `saved` 是除 current 之外被本机保留的账号。
 * 注意 current 同样也保存在本地；它的 cookies 在 WebView 的 session 里。
 */
export interface LoginAccountsSnapshot {
  current: SavedLoginAccount | null;
  saved: SavedLoginAccount[];
}

/**
 * 账号在本机保存的固定信息。当前两项：400 电话（自由文本）、管家联系人
 * （从 VBK 接口下拉选择，需要保存联系卡 ID 以便后续回填）。地接社名称属于
 * 自动化在 VBK 当前页下拉里选的运行时数据，不属于账号固定信息。
 */
export type AccountFixedInfoFieldKey = "servicePhone" | "butlerName";

export type AccountFixedInfoValue = string | ContactCardSelection;

export interface ContactCardSelection {
  /** VBK 上的联系人卡 ID，用于 selectedContactCardIdList 回填。 */
  contactCardId: number;
  /** 联系人显示名；同时作为设置里给人看的文案。 */
  displayName: string;
  /** 联系人卡所属供应商 ID，调用接口时回传 providerId。 */
  providerId: number;
}

export interface AccountFixedInfoField {
  key: AccountFixedInfoFieldKey;
  label: string;
  placeholder: string;
  /** 输入为空时使用，渲染成「未设置」。 */
  emptyText: string;
  description?: string;
  /** 字段的录入形态：text 是文本框，select 是下拉选择（值由 ContactCardSelection 提供）。 */
  kind: "text" | "select";
}

export interface AccountFixedInfo {
  accountName: string;
  values: Partial<Record<AccountFixedInfoFieldKey, AccountFixedInfoValue>>;
}

/**
 * VBK 接口返回的管家/联系人选项，用于弹窗里下拉展示。
 */
export interface ProviderContactCard {
  contactCardId: number;
  displayName: string;
  providerId: number;
  /** 接口可能附带额外字段（职位、手机号、是否默认等），原样透传给上层。 */
  extra?: Record<string, unknown>;
}

export interface AiResponse {
  reply: string;
  patch?: Array<{ op: "add" | "replace" | "remove"; path: string; value?: unknown }>;
  questions?: string[];
  researchTasks?: Array<Pick<ResearchTask, "label" | "type" | "detail">>;
}

/* ============================================================
 * 操作日志：浏览器自动化每一次点击、输入、校验、跳转都留痕，
 * 供运营事后定位失败原因、复跑某一步或回查现场。
 * ============================================================ */

export type OperationType =
  | "runtime"
  | "click"
  | "input"
  | "navigate"
  | "verify"
  | "screenshot"
  | "wait"
  | "select"
  | "upload";

export type OperationStatus = "succeeded" | "failed" | "skipped" | "running";
export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogSource = "main" | "renderer" | "automation" | "system";

export interface OperationLogEntry {
  id: string;
  /** 关联到的本地产品 ID；undefined 表示全局操作（如登录态维护）。 */
  localProductId?: string;
  /** 关联到的产品名称，方便在不切产品时识别。 */
  productName?: string;
  type: OperationType;
  /** 操作可读的名称，如「点击确认删除」「输入产品名称」。 */
  name: string;
  status: OperationStatus;
  /** 自动化阶段，如 basicInfo / saleControl。 */
  stage?: string;
  /** 该阶段下的子步骤，如 supplier / productName。 */
  phase?: string;
  /** 第几次尝试，1 起。 */
  attempt: number;
  startedAt: string;
  durationMs: number;
  /** 失败或跳过时的说明；成功留空。 */
  message?: string;
  /** 操作目标的 VBK 选择器/字段路径，便于运营定位。 */
  target?: string;
  /** 日志严重级别；历史操作记录缺省按 info 展示。 */
  level?: LogLevel;
  /** 日志产生位置，帮助区分主进程、页面和自动化。 */
  source?: LogSource;
  /** 从 `[planning]` 这类前缀提取出的模块名。 */
  module?: string;
  /** 已脱敏的结构化上下文；仅用于平台详情与安全导出。 */
  context?: Record<string, unknown>;
}

export interface OperationLogSummary {
  total: number;
  succeeded: number;
  failed: number;
  skipped: number;
  /** 当前正在进行的条目数（status === 'running'），便于在标题里表达"还在跑"。 */
  running: number;
  debug: number;
  info: number;
  warn: number;
  error: number;
}

export interface OperationLogQuery {
  query?: string;
  status?: OperationStatus | "all";
  type?: OperationType | "all";
  stage?: string | "all";
  localProductId?: string;
  level?: LogLevel | "all";
  source?: LogSource | "all";
  /** 上限条数；缺省走 OPERATION_LOG_CAP。 */
  limit?: number;
}

export interface OperationLogPage {
  summary: OperationLogSummary;
  entries: OperationLogEntry[];
  /** 用于过滤下拉的可用阶段列表。 */
  stages: string[];
  sources: LogSource[];
  /** 刷新时间戳（ISO），方便头部显示「最近更新于…」并避免重复拉取。 */
  refreshedAt: string;
}

export interface RuntimeLogCaptureInput {
  level: LogLevel;
  source: LogSource;
  occurredAt: string;
  message: string;
  module?: string;
  context?: Record<string, unknown>;
}

export interface OperationLogExportResult {
  canceled: boolean;
  count: number;
  path?: string;
}
export interface ItinerarySpot {
  name: string;
  poiName: string | null;
  poiId: number | null;
  province?: string | null;
  city?: string | null;
  district?: string | null;
}
export interface ItineraryDay { day: number; title: string; spots?: ItinerarySpot[]; description: string; hotel: string; meals: string }

/* ============================================================
 * Legacy / internal place-candidate shapes
 * ------------------------------------------------------------
 * 历史占位：src/main/infrastructure/cover-place-search.ts 仍按
 *   "按关键词 + 后缀并行拉 suggestPoiDetail → 去重 → getImageInfo 回填"
 * 的链路返回 cover 候选；该链路在 review-summary / cover-actions /
 * basic-info-cover-row 等 cover UI 里已被
 *   `CtripLibraryImageCandidate` / `CtripLibrarySearchResult`
 * 替代，不再被新 cover UI 使用。
 *
 * 这里只导出旧形状（CoverPlaceCandidate / CoverPlaceSearchResult），
 * 让 cover-place-search 及其 tsx --test 仍能编译通过；renderer /
 * actions 不应再 import 这两个类型。后续如彻底下线 place-search
 * 链路，可整块删除。
 * ============================================================ */

/** 旧版 cover 候选：按 keyword + 多个后缀变体并行查询 VBK suggestPoiDetail
 *  合并去重后再用 getImageInfo 回填 imageUrl / score / resolution 等字段。
 *  - kind 取自触发它的 variant（原始 keyword → "keyword"，加 "景区" → "scenic"，
 *    加 "景点" → "spot"，加 "城市" → "city"），用于排序与 UI 行内展示；
 *  - stableId 是候选的稳定主键：poiId 优先，否则用归一化的 poiName；
 *  - imageUrl / imageId / score / resolution：textFields 抽出或 getImageInfo 回填；
 *  - imageInfoPoiId / imageInfoPoiName：来自 getImageInfo，与 candidate.poiId
 *    / candidate.poiName 可能不同（图片所属 POI），保留便于产物比对。
 *
 *  ⚠️ 不再被 cover UI 使用；不要把 CoverPlaceCandidate 接到
 *  BasicInfoCoverRow / cover actions / review props 上。
 */
export interface CoverPlaceCandidate {
  stableId: string;
  label: string;
  poiName: string;
  poiId: number | null;
  kind: "keyword" | "scenic" | "spot" | "city";
  /** 行内展示的派生文本（cityName / provinceName / address 归一）。 */
  detail?: string;
  /** 缩略图 URL（textFields 抽出或 getImageInfo 回填，缺图时 undefined）。 */
  imageUrl?: string;
  /** 携程图库 imageId，由 textFields 抽取或 getImageInfo 回填。 */
  imageId?: number;
  /** getImageInfo 返回的质量分。 */
  score?: number;
  /** getImageInfo 返回的原图分辨率文本，例如 "1280*1917"。 */
  resolution?: string;
  /** getImageInfo 返回的图片所属 POI ID。 */
  imageInfoPoiId?: number;
  /** getImageInfo 返回的图片所属 POI 名称。 */
  imageInfoPoiName?: string;
}

/** 旧版 cover 占位搜索结果：keyword + candidates + errors + fetchedAt。
 *  - keyword 是 trim 后的用户输入；空 keyword 时为 ""；
 *  - candidates 已按 kind 优先级 + label 长度 / 中文 locale 排序；
 *  - errors 记录单个 variant 失败 / getImageInfo 失败的容错信息，候选
 *    即使失败也会照常返回。
 *
 *  ⚠️ 不再被 cover UI 使用；新链路走
 *  `CtripLibraryImageCandidate` / `CtripLibrarySearchResult`。
 */
export interface CoverPlaceSearchResult {
  keyword: string;
  candidates: CoverPlaceCandidate[];
  errors: Array<{ variant: string; message: string }>;
  fetchedAt: string;
}
