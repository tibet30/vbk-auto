import type {
  CreateProductInput,
  AiConnectionTestInput,
  AiModelListInput,
  AiModelListResult,
  AiRegenerateField,
  CtripLibraryPlaceCandidate,
  CtripLibraryPlaceSearchResult,
  CtripLibrarySearchResult,
  LoginAccountsSnapshot,
  ManualReviewFieldInput,
  ConnectionTest,
  ManualUploadCoverMeta,
  VbkLoginStatus,
  OperationLogPage,
  OperationLogQuery,
  OperationLogExportResult,
  RuntimeLogCaptureInput,
  PoiSuggestDetailResult,
  PoiSuggestLogContext,
  ProductDetail,
  ProductReadiness,
  ProductSummary,
  Settings,
  VehicleResourceMatch,
  HotelResourceMatch,
  AccountFixedInfo,
  AccountFixedInfoField,
  AccountFixedInfoFieldKey,
  AccountFixedInfoValue,
  ProviderContactCard,
} from "./contracts-types.js";
import type { PlanningGenerationState, PlanningMajorStage, PlanningModule } from "./contracts-planning.js";
import type {
  AppAuthAccountsSnapshot,
  AppAuthCaptcha,
  AppAuthLoginInput,
  AppAuthStatus,
} from "./contracts-auth.js";

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
  appAuth: {
    status(): Promise<AppAuthStatus>;
    listAccounts(): Promise<AppAuthAccountsSnapshot>;
    captcha(): Promise<AppAuthCaptcha>;
    login(input: AppAuthLoginInput): Promise<AppAuthStatus>;
    switchAccount(userId: number): Promise<AppAuthStatus>;
    startLogin(): Promise<void>;
    logout(): Promise<void>;
  };
  products: {
    list(): Promise<ProductSummary[]>;
    create(input: CreateProductInput): Promise<ProductDetail>;
    get(id: string): Promise<ProductDetail>;
    delete(id: string): Promise<void>;
    readiness(id: string): Promise<ProductReadiness>;
    updateReviewField(id: string, input: ManualReviewFieldInput): Promise<ProductDetail>;
    updateProductJson(id: string, json: string): Promise<ProductDetail>;
  };
  ai: {
    send(localProductId: string, content: string): Promise<void>;
    cancel(localProductId: string): Promise<{ cancelled: boolean }>;
    /**
     * 单字段 AI 重新生成：目前仅实现 subtitle，返回生成的候选副标题（**不落库**）；
     * 由调用方展示候选、用户确认后再经 products.updateReviewField 写入。
     * 其它字段暂未发布，调用会抛错。
     */
    regenerate(localProductId: string, field: AiRegenerateField): Promise<string>;
  };
  research: {
    accept(localProductId: string, taskId: string, note?: string): Promise<void>;
    refreshIssues(localProductId: string): Promise<{ updated: number; taskIds: string[]; product: ProductDetail; readiness: ProductReadiness }>;
    resolveVehicleResource(localProductId: string, taskId?: string): Promise<VehicleResourceMatch | undefined>;
    resolveHotelResource(localProductId: string, taskId?: string): Promise<HotelResourceMatch>;
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
    suggestPoi(keyword: string): Promise<{ poiName: string; poiId: number } | null>;
    suggestPoiDetail(keyword: string, context?: PoiSuggestLogContext): Promise<PoiSuggestDetailResult>;
    suggestPoiDemo(keyword: string): Promise<unknown>;
  };
  automation: {
    start(localProductId: string): Promise<void>;
    retry(localProductId: string): Promise<void>;
    retryPhase(localProductId: string, phase: string): Promise<void>;
    /**
     * 单阶段重新执行：在不重启其他阶段的前提下重跑一个阶段，用于运营
     * review 某阶段在 VBK 当前页面的填充效果。不要求阶段是 failed
     * 状态 —— completed / pending 都可以触发；后续阶段状态不变。
     */
    retryOnePhase(localProductId: string, phase: string): Promise<void>;
    /**
     * 用户主动中止当前产品的自动录入。立即把 AutomationRun 标记为
     * cancelled 并落盘（UI 可立刻看到「已停止」），已经在跑的当前阶段
     * handler 会自然结束后停止后续阶段 —— 当前 Playwright 调用无法
     * 跨进程 abort，安全起见不强制中断 in-flight click。
     */
    stop(localProductId: string): Promise<void>;
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
    suggestPoi(keyword: string): Promise<{ poiName: string; poiId: number } | null>;
  };
  cover: {
    /**
     * 手动上传封面图片：
     *  - renderer 把图片转 base64 → main 端解码 → 走 cover-storage 校验 →
     *    返回 ManualUploadCoverMeta；
     *  - 真正的字节永不进 product JSON。
     */
    uploadManual(args: { originalName: string; mimeType: string; base64: string }): Promise<ManualUploadCoverMeta>;
    /**
     * 读取手动上传图片预览（main 端把本地副本读成 data URL）：
     *  - 返回的 `url` 可直接喂给 `<img src>`，格式为 `data:${mime};base64,...`；
     *  - **历史变更**：旧版返回 `file://` 路径，在 Electron + 沙盒 + 路径编码下
     *    偶发破图；新版统一走 data URL，避免对 filesystem 的直接访问；
     *  - 文件丢失或 IO 失败返回 `url=null` + 持久化 meta（如果有），UI 走
     *    「图片已失效，请重新上传」提示；
     *  - data URL 仅本次 IPC 临时返回，**不**写入 product JSON / 任何持久层；
     *    renderer 只用其渲染预览，别存到 state / draft / notice 等位置。
     */
    read(args: { fileId: string; originalName: string }): Promise<{ url: string | null; mimeType: string | null; sizeBytes: number | null; uploadedAt: string | null; originalName: string | null }>;
    /** 列出现存所有手动上传 meta（仅元数据，无二进制）。 */
    listManual(): Promise<{ supportedMimeTypes: readonly string[]; records: ManualUploadCoverMeta[] }>;
    /** 判断 fileId 本地副本是否还在；UI 用作"图片已失效"判定。 */
    exists(args: { fileId: string; originalName: string }): Promise<boolean>;
    /**
     * 按景点 / 景区名称（scenic/attraction name）查询携程图库地址候选列表（阶段 A）：
     *  - main 端走 suggestpoi.json（soa2/15638），在 BrowserView 内联 fetch 完成，
     *    **不再**调用 VBK 旧 suggestPoi / suggestPoiDetail / 任何 DOM 弹窗；
     *  - keyword 必须是字符串（trim 后非空），由 renderer UI 的「景点名称」输入框
     *    收集；空字符串由 UI 拦截，不进入 IPC；
     *  - 返回 CtripLibraryPlaceSearchResult：places 是合法候选（poiId + poiName
     *    都齐备）按 suggestPoi 原始顺序排列；address / province / city / district
     *    按 suggestPoi 响应里的常见 key 抽取，缺时为 null；
     *  - UI 在地址列表里选中一个 place 后再调用 searchCtripLibraryImages 走阶段 B；
     *  - 错误由查询函数直接抛出（业务失败 / 网络失败 / 鉴权失败等）。
     */
    searchCtripLibraryPlaces(args: { keyword: string }): Promise<CtripLibraryPlaceSearchResult>;
    /**
     * 按已选 place 取该地址下的携程图库图片列表（阶段 B）：
     *  - 必须先有合法的 place（poiId 正整数 + poiName 非空），由阶段 A 的
     *    searchCtripLibraryPlaces 选出来；UI 选中后传入；
     *  - main 端走 searchImage（soa2/12719）→ getImageInfo（soa2/12719），
     *    在 BrowserView 内联 fetch 完成；不依赖 DOM 弹窗 / importpic-modal；
     *  - 业务失败 / 未登录 / place 不合法时直接抛出；返回 CtripLibrarySearchResult
     *    仅含 image candidates，每条 candidate 必含 imageId + imageUrl（缺一即
     *    视为「未取到图库图片」不会进入 product）；keyword / poi 字段保留回显用；
     *  - 选中某候选 → renderer 把它写回 product.presentation.cover 的 ctripLibrary
     *    形态（imageId / imageUrl 必填，poi / description 来自 poiName 或兜底）。
     */
    searchCtripLibraryImages(args: { keyword: string; place: CtripLibraryPlaceCandidate }): Promise<CtripLibrarySearchResult>;
  };
  settings: {
    get(): Promise<Settings>;
    listModels(input: AiModelListInput): Promise<AiModelListResult>;
    save(input: Partial<Settings> & { apiKey?: string; deepseekApiKey?: string }): Promise<Settings>;
    test(input: AiConnectionTestInput): Promise<ConnectionTest>;
  };
  events: {
    onProductUpdated(listener: (product: ProductDetail) => void): () => void;
    /** 主进程成功持久化规划状态后推送；订阅者必须按 localProductId 过滤。 */
    onPlanningStateUpdated(listener: (localProductId: string, state: PlanningGenerationState) => void): () => void;
    /** VBK 页面加载完成、SPA 渲染就绪后推送；renderer 收到后触发 checkVbkLogin。 */
    onPageReady(listener: () => void): () => void;
  };
  operationLog: {
    load(query?: OperationLogQuery): Promise<OperationLogPage>;
    capture(input: RuntimeLogCaptureInput): Promise<void>;
    export(query?: OperationLogQuery): Promise<OperationLogExportResult>;
    /** 用系统默认应用打开刚导出的日志文件（绝对路径）。 */
    open(path: string): Promise<void>;
  };
  planning: {
    /** 从骨架开始跑一遍（首次创建产品后调用）；写入持久化状态。 */
    start(localProductId: string): Promise<PlanningRunResult>;
    /** 从持久化状态里的 currentStage 续跑。 */
    resume(localProductId: string): Promise<PlanningRunResult>;
    /** 读取现有状态；不存在返回 undefined。 */
    state(localProductId: string): Promise<PlanningGenerationState | undefined>;
    /** 重做一个大阶段；该阶段及下游节点会失效并立即按新流程执行。 */
    rerunMajorStage(localProductId: string, stage: PlanningMajorStage): Promise<PlanningRunResult>;
    /** 采用当前对话行程：先核验真实 POI，再失效并重跑全部产品补全节点。 */
    acceptItineraryAndRerunCompletion(localProductId: string): Promise<PlanningRunResult>;
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
