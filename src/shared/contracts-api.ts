import type {
  CreateProjectInput,
  AiConnectionTestInput,
  AiModelListInput,
  AiModelListResult,
  AiRegenerateField,
  LoginAccountsSnapshot,
  ManualReviewFieldInput,
  ConnectionTest,
  VbkLoginStatus,
  OperationLogPage,
  OperationLogQuery,
  ProjectDetail,
  ProjectReadiness,
  ProjectSummary,
  Settings,
  VehicleResourceMatch,
  VehicleResourcePricePreview,
  HotelResourceMatch,
  AccountFixedInfo,
  AccountFixedInfoField,
  AccountFixedInfoFieldKey,
  AccountFixedInfoValue,
  ProviderContactCard,
} from "./contracts-types.js";
import type { PlanningGenerationState, PlanningModule } from "./contracts-planning.js";

/**
 * IPC 契约：renderer ↔ main 的强类型接口。
 *
 * `VbkApi` 描述了 renderer 端可以调用的全部 IPC 方法。修改本接口后
 * 需同步实现：
 *  - main 端：在 `main.ts` 的 `registerIpc()` 中增补 handler；
 *  - preload 端：在 `preload.cts` 暴露同名 API；
 *  - renderer 端：`useAppActions` 等钩子里调用。
 *
 * 同一模块（例如 `browser`、`automation`、`accounts`、`settings`）内部按职责分组，
 * 新方法请加到对应分组下，不要在末尾追加。
 */

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
    /** 取嵌入式 VBK 浏览器的当前 URL。URL 栏需要实时反映实际页面以便观察「进入」跳转是否生效。 */
    currentUrl(): Promise<string>;
    openExternal(): Promise<void>;
    setBounds(bounds: { x: number; y: number; width: number; height: number }): Promise<void>;
    setVisible(visible: boolean): Promise<void>;
    /**
     * 列出当前 WebView 实际账号 + 本机已保存的所有 VBK 登录账号（按最近使用排序）。
     * "新增登录" / "切换到 xxx" / "忘记 xxx" 都依赖这个视图。
     */
    listLoginAccounts(): Promise<LoginAccountsSnapshot>;
    /**
     * 把当前 WebView 中已登录账号的 cookies 抽出来存到本机，
     * 然后清空 session 并跳到 VBK 登录页，让用户登录另一个账号。
     *
     * 1. 若当前未登录：直接打开 VBK 登录页（不保存任何快照）；
     * 2. 若当前已登录：先把当前 cookies 存到 `current.loginAccount` 对应的快照，
     *    再清空 session，再导航到登录页；
     * 3. 等用户在右侧 WebView 走完登录后，status 流程会自动保存新的快照。
     */
    addLogin(): Promise<void>;
    /**
     * 切换到本机已经记录过的一个 VBK 账号：
     * 1. 当前账号已登录则先存快照；
     * 2. 把目标账号的 cookies 回灌到 session；
     * 3. 重新导航到产品列表，让 VBK 自动 refresh 账号。
     */
    switchAccount(accountKey: string): Promise<void>;
    /**
     * 忘记（删除）本机记着的某个账号快照。被 WebView 当前展示的账号不可忘记，
     * 调用方需先切换 / 登出。
     */
    forgetAccount(accountKey: string): Promise<void>;
    suggestPoi(keyword: string): Promise<{ poiName: string; poiId: string } | null>;
    suggestPoiDemo(keyword: string): Promise<unknown>;
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
    suggestPoi(keyword: string): Promise<{ poiName: string; poiId: string } | null>;
  };
  settings: {
    get(): Promise<Settings>;
    listModels(input: AiModelListInput): Promise<AiModelListResult>;
    save(input: Partial<Settings> & { apiKey?: string; deepseekApiKey?: string }): Promise<Settings>;
    test(input: AiConnectionTestInput): Promise<ConnectionTest>;
  };
  events: {
    onProjectUpdated(listener: (project: ProjectDetail) => void): () => void;
    /** 主进程成功持久化规划状态后推送；订阅者必须按 projectId 过滤。 */
    onPlanningStateUpdated(listener: (projectId: string, state: PlanningGenerationState) => void): () => void;
  };
  operationLog: {
    load(query?: OperationLogQuery): Promise<OperationLogPage>;
  };
  planning: {
    /** 从骨架开始跑一遍（首次创建项目后调用）；写入持久化状态。 */
    start(projectId: string): Promise<PlanningRunResult>;
    /** 从持久化状态里的 currentStage 续跑。 */
    resume(projectId: string): Promise<PlanningRunResult>;
    /** 读取现有状态；不存在返回 undefined。 */
    state(projectId: string): Promise<PlanningGenerationState | undefined>;
  };
}

/** renderer 可见的规划结果摘要（状态 + 接受 / 拒绝模块 + 助手回复）。 */
export interface PlanningRunResult {
  state: PlanningGenerationState;
  status: "completed" | "needs_user" | "failed";
  accepted: PlanningModule[];
  rejected: Array<{ module: PlanningModule; reason?: string }>;
  researchTasks: Array<{ label: string; type: "vbk" | "web" | "cost" | "image"; detail?: string }>;
  assistantReply: string;
}
