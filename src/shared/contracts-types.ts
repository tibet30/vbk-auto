export type FieldState =
  | "proposed"
  | "researching"
  | "resolved"
  | "needs_confirmation"
  | "confirmed"
  | "blocked";

export type TaskStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export interface ProjectSummary {
  id: string;
  name: string;
  status: "planning" | "review" | "automating" | "draft_saved" | "blocked";
  productId?: string;
  updatedAt: string;
}

export interface CreateProjectInput {
  destination: string;
  days: number;
  productForm: "privateTour" | "groupTour";
}

export interface ProjectReadiness {
  ready: boolean;
  completion: number;
  issues: Array<{ label: string; detail: string }>;
}

export interface ProjectDetail extends ProjectSummary {
  product: Record<string, unknown>;
  messages: ConversationMessage[];
  researchTasks: ResearchTask[];
  automation?: AutomationRun;
  /** 基本信息是否已在 VBK 成功保存，决定重试时是否需要补跑 basic 阶段。 */
  basicInfoSaved?: boolean;
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

export interface VehicleResourceMatch {
  query: string;
  city: string;
  days: number;
  dailyCost: number;
  totalCost: number;
  resourceGroupId: number;
  resourceGroupName: string;
}

export type AiRegenerateField = "subtitle" | "province" | "operationNotes" | "pricing" | "itinerary" | "sellingPoints";

export type ManualReviewFieldInput =
  { field: "pricing"; adult: number; child: number };

export interface VehicleResourcePricePreview extends VehicleResourceMatch {
  previewId: string;
  requestedDailyCost: number;
  matchedDailyCost: number;
  matchMode: "exact" | "roundedUp";
}

export interface HotelResourceMatch {
  source: "vbk" | "nonPlatform";
  resourceId?: number;
  resourceName: string;
  supplierCode?: string;
  roomType?: string;
  query?: string;
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
  | "click"
  | "input"
  | "navigate"
  | "verify"
  | "screenshot"
  | "wait"
  | "select"
  | "upload";

export type OperationStatus = "succeeded" | "failed" | "skipped" | "running";

export interface OperationLogEntry {
  id: string;
  /** 关联到的产品项目 ID；undefined 表示全局操作（如登录态维护）。 */
  projectId?: string;
  /** 关联到的产品名称，方便在不切项目时识别。 */
  projectName?: string;
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
}

export interface OperationLogSummary {
  total: number;
  succeeded: number;
  failed: number;
  skipped: number;
  /** 当前正在进行的条目数（status === 'running'），便于在标题里表达"还在跑"。 */
  running: number;
}

export interface OperationLogQuery {
  query?: string;
  status?: OperationStatus | "all";
  type?: OperationType | "all";
  stage?: string | "all";
  projectId?: string;
  /** 上限条数；缺省走 OPERATION_LOG_CAP。 */
  limit?: number;
}

export interface OperationLogPage {
  summary: OperationLogSummary;
  entries: OperationLogEntry[];
  /** 用于过滤下拉的可用阶段列表。 */
  stages: string[];
  /** 刷新时间戳（ISO），方便头部显示「最近更新于…」并避免重复拉取。 */
  refreshedAt: string;
}
