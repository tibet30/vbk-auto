import type {
  CreateProjectInput,
  AiRegenerateField,
  ManualReviewFieldInput,
  MiniMaxConnectionTest,
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
  operationLog: {
    load(query?: OperationLogQuery): Promise<OperationLogPage>;
  };
}
