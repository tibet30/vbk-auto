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
 * AI 歧义消除：在 VBK 下拉里选不到精确项时，把候选项列表发给 MiniMax，让它
 * 选一个最像的（或者明确表示「无匹配」）。用在景区、景点、城市、车站等所有
 * 严格选择场景下。
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

export interface Settings {
  minimaxBaseUrl: string;
  minimaxModel: string;
  hasMiniMaxKey: boolean;
  dataPath: string;
}

export interface MiniMaxConnectionTest {
  connected: boolean;
  message: string;
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
  /** VBK 页面展示名，例如“小璐”。 */
  accountName?: string;
  /** VBK 登录账号，例如“vbk_671205”。 */
  loginAccount?: string;
  accounts?: string[];
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

export interface VbkApi {
  projects: {
    list(): Promise<ProjectSummary[]>;
    create(input: CreateProjectInput): Promise<ProjectDetail>;
    get(id: string): Promise<ProjectDetail>;
    delete(id: string): Promise<void>;
    readiness(id: string): Promise<ProjectReadiness>;
    updateReviewField(id: string, input: ManualReviewFieldInput): Promise<ProjectDetail>;
    updateProductJson(id: string, json: string): Promise<ProjectDetail>;
  };
  ai: {
    send(projectId: string, content: string): Promise<void>;
    regenerate(projectId: string, field: AiRegenerateField): Promise<void>;
  };
  research: {
    accept(projectId: string, taskId: string, note?: string): Promise<void>;
    resolveVehicleResource(projectId: string, taskId?: string): Promise<VehicleResourceMatch>;
    previewVehicleResourceByPrice(projectId: string, dailyCost: number): Promise<VehicleResourcePricePreview>;
    confirmVehicleResourcePreview(projectId: string, previewId: string): Promise<VehicleResourceMatch>;
    resolveHotelResource(projectId: string, taskId?: string): Promise<HotelResourceMatch>;
  };
  browser: {
    login(): Promise<void>;
    logout(): Promise<void>;
    status(refresh?: boolean): Promise<VbkLoginStatus>;
    navigate(url: string): Promise<void>;
    openExternal(): Promise<void>;
    setBounds(bounds: { x: number; y: number; width: number; height: number }): Promise<void>;
    setVisible(visible: boolean): Promise<void>;
  };
  automation: {
    start(projectId: string): Promise<void>;
    retry(projectId: string): Promise<void>;
    retryPhase(projectId: string, phase: string): Promise<void>;
    /**
     * 单阶段重新执行：在不重启其他阶段的前提下重跑一个阶段，用于运营
     * review 某阶段在 VBK 当前页面的填充效果。不要求阶段是 failed
     * 状态 —— completed / pending 都可以触发；后续阶段状态不变。
     */
    retryOnePhase(projectId: string, phase: string): Promise<void>;
    /**
     * 用户主动中止当前项目的自动录入。立即把 AutomationRun 标记为
     * cancelled 并落盘（UI 可立刻看到「已停止」），已经在跑的当前阶段
     * handler 会自然结束后停止后续阶段 —— 当前 Playwright 调用无法
     * 跨进程 abort，安全起见不强制中断 in-flight click。
     */
    stop(projectId: string): Promise<void>;
  };
  /**
   * 调试入口：让 CLI / IDE 能逐函数调用 ctrip.ts，单步观察 VBK 页面状态。
   * 通过 IPC 调用 DraftAutomation，settings/storage 不变。
   */
  debug: {
    /** 执行一个具名步骤（例如「selectStationAddress」）。返回 JSON 可序列化结果。 */
    runStep(stepName: string, argsJson: string): Promise<unknown>;
    /** 取当前 VBK 页面快照。 */
    snapshot(label?: string): Promise<unknown>;
    /** 列出本次进程内已命中的断点。 */
    hitBreakpoints(): Promise<string[]>;
    /** 远程 resume（continue/step/stop）。 */
    resume(command: "continue" | "step" | "stop"): Promise<{ stopped: boolean }>;
    /** 查看当前配置的断点列表（来源：env VBK_DEBUG_BREAKPOINTS）。 */
    listBreakpoints(): Promise<string[]>;
  };
  accounts: {
    /** 返回 VBK 账号在本机保存的固定信息（当前：400 电话、管家联系人）。 */
    getFixedInfo(accountName: string): Promise<AccountFixedInfo>;
    /** 保存某 VBK 账号的固定信息；未填写的字段保持现状。 */
    saveFixedInfo(accountName: string, values: Partial<Record<AccountFixedInfoFieldKey, AccountFixedInfoValue | null>>): Promise<AccountFixedInfo>;
    /** 弹窗里展示的字段定义（label / placeholder / 空文案 / kind），前端只读。 */
    fixedInfoSchema(): Promise<AccountFixedInfoField[]>;
    /** 从当前已登录的 VBK 浏览器页面自动识别 providerId，抓不到返回 null。 */
    detectProviderId(): Promise<number | null>;
    /** 返回 main 进程已缓存的当前账号 providerId（登录后由 scheduleProviderIdRefresh 写入）。 */
    currentProviderId(): Promise<number | null>;
    /** 列出本机所有登过的 VBK 账号及其历史 providerId（如有）。供设置页 / 顶栏展示。 */
    listKnownAccounts(): Promise<Array<{ accountName: string; providerId?: number }>>;
    /** 按账号名查 providerId；未记录返回 null。 */
    providerIdFor(accountName: string): Promise<number | null>;
  };
  contacts: {
    /** 在 VBK 已登录的浏览器上下文里拉取 providerId 对应的联系人卡片列表。 */
    listProviderContactCards(providerId: number, searchKeyword?: string): Promise<ProviderContactCard[]>;
  };
  settings: {
    get(): Promise<Settings>;
    getApiKey(): Promise<string>;
    save(input: Partial<Settings> & { apiKey?: string }): Promise<Settings>;
    test(input: Pick<Settings, "minimaxBaseUrl"> & { apiKey?: string }): Promise<MiniMaxConnectionTest>;
  };
  events: { onProjectUpdated(listener: (project: ProjectDetail) => void): () => void };
}
