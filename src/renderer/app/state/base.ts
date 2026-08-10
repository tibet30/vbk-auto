import { useCallback, useEffect, useRef, useState } from "react";
import type {
  AccountFixedInfo,
  AccountFixedInfoField,
  AccountFixedInfoValue,
  ContactCardSelection,
  CreateProjectInput,
  ConnectionTest,
  AiModelInfo,
  LoginAccountsSnapshot,
  ProjectDetail,
  ProjectReadiness,
  ProjectSummary,
  ProviderContactCard,
  Settings as AppSettings,
  VbkLoginStatus,
} from "../../../shared/contracts.js";
import { api, emptyReadiness, initialInput } from "../helpers";

type View = "workspace" | "projects" | "settings" | "operation-log";
const VIEW_STORAGE_KEY = "vbk:view";
// 最近打开的项目 id：仅持久化 id（不持久化整个 ProjectDetail）。
// 刷新 / 重启后由 derived 层异步从主进程拉权威数据恢复，避免工作台首页闪现。
const ACTIVE_PROJECT_STORAGE_KEY = "vbk:activeProjectId";

function readInitialView(): View {
  try {
    const raw = localStorage.getItem(VIEW_STORAGE_KEY);
    if (raw === "workspace" || raw === "projects" || raw === "settings" || raw === "operation-log") return raw;
  } catch { /* 某些 Electron 环境下 localStorage 不可用 */ }
  return "workspace";
}

function readInitialActiveProjectId(): string | null {
  try {
    const raw = localStorage.getItem(ACTIVE_PROJECT_STORAGE_KEY);
    return raw && raw.length > 0 ? raw : null;
  } catch { /* 某些 Electron 环境下 localStorage 不可用 */ }
  return null;
}

export function useAppStateBase() {
  // 在 Electron 预加载脚本生效之前，window.vbk 可能是 undefined；
  // 路由层靠 apiAvailable 决定是否调用主进程，避免初始化时报警告。
  const apiAvailable = Boolean(api());
  const [view, setViewRaw] = useState<View>(readInitialView);
  const setView = useCallback((next: View) => {
    try { localStorage.setItem(VIEW_STORAGE_KEY, next); } catch { /* 忽略 */ }
    setViewRaw(next);
  }, []);
  const [project, setProject] = useState<ProjectDetail | null>(null);
  // 持久化的「最近打开的项目 id」：启动 / 刷新后用来从主进程恢复 project。
  // 与 project 本身解耦——project 是内存中的大对象，id 只是字符串。
  const [activeProjectId, setActiveProjectId] = useState<string | null>(readInitialActiveProjectId);
  // 首次挂载跳过同步：activeProjectId 已经从 localStorage 读出来，再写一次会
  // 把它在 mount 阶段清掉（project 初始为 null），导致永远恢复不了。
  const hasSyncedActiveProjectRef = useRef(false);
  useEffect(() => {
    if (!hasSyncedActiveProjectRef.current) {
      hasSyncedActiveProjectRef.current = true;
      return;
    }
    const nextId = project?.id ?? null;
    // localStorage 写入是幂等的，同值反复写也安全；不放在 setState updater
    // 内是为了避开「updater 应保持纯函数」的 React 约定。
    try {
      if (nextId) localStorage.setItem(ACTIVE_PROJECT_STORAGE_KEY, nextId);
      else localStorage.removeItem(ACTIVE_PROJECT_STORAGE_KEY);
    } catch { /* 忽略 localStorage 不可用 */ }
    setActiveProjectId(nextId);
  }, [project?.id]);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [readiness, setReadiness] = useState<ProjectReadiness>(emptyReadiness);
  const [stage, setStage] = useState<"review" | "vbk">("review");
  const [input, setInput] = useState("");
  const [createInput, setCreateInput] = useState<CreateProjectInput>(initialInput);
  const [creating, setCreating] = useState(false);
  const [savingProject, setSavingProject] = useState(false);
  const [loading, setLoading] = useState(false);
  const [browserOpen, setBrowserOpen] = useState(false);

  // 嵌入式 VBK 浏览器的当前 URL —— 用于 URL 栏实时显示「进入」跳转后的真实地址
  // 否则地址栏一直写死「/产品库」会让用户误以为「进入」按钮没生效。
  const [browserUrl, setBrowserUrl] = useState("");
  const [loginPanelOpen, setLoginPanelOpen] = useState(false);
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);

  // 账号固定信息（管家联系人 / 400 电话）编辑弹窗
  const [editingAccount, setEditingAccount] = useState<string | null>(null);
  const [fixedInfoSchema, setFixedInfoSchema] = useState<AccountFixedInfoField[]>([]);
  const [fixedInfoDraft, setFixedInfoDraft] = useState<Partial<Record<string, AccountFixedInfoValue>>>({});
  const [fixedInfoSaving, setFixedInfoSaving] = useState(false);
  // 管家联系人选择器（懒加载，进入编辑器不预拉）。
  const [butlerPickerOpen, setButlerPickerOpen] = useState(false);
  const [currentProviderId, setCurrentProviderId] = useState<number | null>(null);
  const [contactCards, setContactCards] = useState<ProviderContactCard[]>([]);
  const [contactCardsLoading, setContactCardsLoading] = useState(false);
  const [contactCardSearch, setContactCardSearch] = useState("");

  /**
   * 「基础信息」编辑模块（右侧 review 面板）：
   *  - basicInfoDraft：本地输入中的值，尚未保存到 product；
   *  - basicInfoSaving：当前正在保存的字段（防止同一字段重复点击）；
   *  - basicInfoErrors：保存失败的字段 → 文案，渲染时贴红错；
   *  - basicInfoButlerDefault：当前账号 AccountFixedInfo.butlerName 默认选中的
   *    ContactCardSelection；进入「基础信息」编辑模块时一次性拉取，写入后即
   *    与 product 同步。账号未设置 / 未登录时为 null。
   *  - basicInfoButlerLoadedForProjectId：已为哪个项目拉过默认值；切换项目时复位。
   * 这些状态在 basic-info 模块的 useEffect 里跟 project.id 联动，避免跨项目污染。
   */
  const [basicInfoDraft, setBasicInfoDraft] = useState<Record<string, string>>({});
  const [basicInfoSaving, setBasicInfoSaving] = useState<string | null>(null);
  const [basicInfoErrors, setBasicInfoErrors] = useState<Record<string, string>>({});
  const [basicInfoButlerDefault, setBasicInfoButlerDefault] = useState<ContactCardSelection | null>(null);
  // 当前账号的 400 电话（来自 AccountFixedInfo.servicePhone）；
  // 仅展示用，不进入 product JSON；空字符串 / null = 未配置。
  const [basicInfoServicePhone, setBasicInfoServicePhone] = useState<string | null>(null);
  const [basicInfoButlerLoadedForProjectId, setBasicInfoButlerLoadedForProjectId] = useState<string | null>(null);

  const [vbkLogin, setVbkLogin] = useState<VbkLoginStatus | null>(null);
  const [checkingVbkLogin, setCheckingVbkLogin] = useState(false);
  // 多账号登录态：当前 WebView 实际账号 + 本机已记录的所有其它 VBK 账号。
  // 与 vbkLogin 不同：vbkLogin 是 status 探测出来的（菜单/DOM/API 兜底），
  // vbkLoginAccounts 是从 main 进程拿到的 login_sessions 表数据，
  // 提供「已记录账号」可点击切换 / 忘记的能力。
  const [vbkLoginAccounts, setVbkLoginAccounts] = useState<LoginAccountsSnapshot>({ current: null, saved: [] });
  const [loadingLoginAccounts, setLoadingLoginAccounts] = useState(false);
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null);
  const [verificationNote, setVerificationNote] = useState("");
  // 刚被 confirmTask 确认的 task id：用于在 task-row 上打 1.2s 绿色闪动。
  const [justConfirmedTaskId, setJustConfirmedTaskId] = useState<string | null>(null);
  const [resolvingVehicleTaskId, setResolvingVehicleTaskId] = useState<string | null>(null);

  // 自动录入阶段列表里“进入”按钮的 loading 状态：按 section.key 跟踪。
  // 同一时间只允许一个“进入”跳转，避免连续点击造成多次导航。
  const [navigatingSection, setNavigatingSection] = useState<string | null>(null);

  // 自动录入阶段列表里“刷新”按钮的 loading 状态：按 phase 名跟踪。
  // 「重新执行」按钮的 loading 状态：按 phase 名跟踪。同一时间只允许一个阶段
  // 被重跑，避免并发调用 automation.retryOnePhase 抢占同一个 Playwright 页面。
  const [retryingPhase, setRetryingPhase] = useState<string | null>(null);

  // 「停止」按钮的点击锁：点击后到 project:updated 携 cancelled 状态返回前，避免重复点击造成双触发。
  const [stoppingAutomation, setStoppingAutomation] = useState(false);

  const [notice, setNotice] = useState<string | null>(null);

  // AI 提供商配置。每个提供商独立 API Key / Base URL / Model。
  const [aiProvider, setAiProvider] = useState<"minimax" | "deepseek">("minimax");
  const [aiConfigOpen, setAiConfigOpen] = useState(false);
  const [aiBaseUrl, setAiBaseUrl] = useState("https://api.minimaxi.com/v1");
  const [aiApiKey, setAiApiKey] = useState("");
  const [aiModel, setAiModel] = useState("");
  const [showAiApiKey, setShowAiApiKey] = useState(false);
  const [savingAi, setSavingAi] = useState(false);
  const [testingAi, setTestingAi] = useState(false);
  const [loadingAiKey, setLoadingAiKey] = useState(false);
  const [aiTest, setAiTest] = useState<ConnectionTest | null>(null);
  const [aiModelList, setAiModelList] = useState<AiModelInfo[] | null>(null);
  const [refreshingAiModels, setRefreshingAiModels] = useState(false);
  const [aiModelListError, setAiModelListError] = useState<string | null>(null);

  // 每日行程可展开卡片：仅第 1 天默认展开；切换项目时重置。
  const [expandedDayIndex, setExpandedDayIndex] = useState<number | null>(0);

  const browserRef = useRef<HTMLDivElement>(null);
  const conversationRef = useRef<HTMLDivElement>(null);

  // 用于判定异步响应回来时用户是否已经切换了项目。
  const currentProjectIdRef = useRef<string | null>(null);
  currentProjectIdRef.current = project?.id ?? null;

  const checkVbkLogin = async (refresh = false) => {
    if (!api()) return;
    setCheckingVbkLogin(true);
    try {
      setVbkLogin(await api()!.browser.status(refresh));
    } catch (error) {
      setVbkLogin({ loggedIn: false, message: error instanceof Error ? error.message : "无法检测 VBK 登录状态。" });
    } finally {
      setCheckingVbkLogin(false);
    }
  };

  /**
   * 拉取本机已记录的 VBK 账号快照。
   * 注意刷新 vbkLoginAccounts 与 checkVbkLogin 是两件事：
   *  - 前者读 login_sessions 表（main 进程），UI 用它显示 chip；
   *  - 后者实际访问 WebView 探测登录态，可能很慢。
   * 两者各拉各的，避免让"刷新账号列表"被网络卡住。
   *
   * 必须用 useCallback 持有稳定引用——设置页 vbk-login-block 的 effect 依赖
   * 本函数引用；若每次 render 都生成新函数，effect 会跟着重跑，调用本函数
   * 又会 setLoadingLoginAccounts(true) → 再 render → 新函数引用 → 循环，
   * 导致新增登录按钮因 loadingLoginAccounts 长期为 true 而 disabled。
   */
  const refreshVbkLoginAccounts = useCallback(async () => {
    if (!api()) return;
    setLoadingLoginAccounts(true);
    try {
      const snapshot = await api()!.browser.listLoginAccounts();
      setVbkLoginAccounts(snapshot);
    } catch (error) {
      setVbkLoginAccounts({ current: null, saved: [] });
      setNotice(error instanceof Error ? error.message : "读取账号列表失败。");
    } finally {
      setLoadingLoginAccounts(false);
    }
  }, []);

  const refresh = async () => {
    if (!api()) return;
    try {
      const next = await api()!.projects.list();
      setProjects(next);
      setProject((current: ProjectDetail | null) => (current && next.some((item: ProjectSummary) => item.id === current.id)) ? current : null);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "无法加载项目列表。");
    }
  };

  const updateReadiness = async (candidate: ProjectDetail | null) => {
    if (!candidate || !api()) return setReadiness(emptyReadiness);
    try {
      const next = await api()!.projects.readiness(candidate.id);
      // 请求期间可能已切到别的项目：迟到的响应不能覆盖当前项目的就绪状态，
      // 否则界面会长期显示另一个项目的检查结果。
      if (currentProjectIdRef.current === candidate.id) setReadiness(next);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "无法获取录入前检查结果。");
    }
  };

  return {
    apiAvailable,
    view,
    setView,
    project,
    setProject,
    activeProjectId,
    setActiveProjectId,
    projects,
    setProjects,
    settings,
    setSettings,
    readiness,
    setReadiness,
    stage,
    setStage,
    input,
    setInput,
    createInput,
    setCreateInput,
    creating,
    setCreating,
    savingProject,
    setSavingProject,
    loading,
    setLoading,
    browserOpen,
    setBrowserOpen,
    browserUrl,
    setBrowserUrl,
    loginPanelOpen,
    setLoginPanelOpen,
    accountMenuOpen,
    setAccountMenuOpen,
    editingAccount,
    setEditingAccount,
    fixedInfoSchema,
    setFixedInfoSchema,
    fixedInfoDraft,
    setFixedInfoDraft,
    fixedInfoSaving,
    setFixedInfoSaving,
    contactCards,
    setContactCards,
    contactCardsLoading,
    setContactCardsLoading,
    contactCardSearch,
    setContactCardSearch,
    butlerPickerOpen,
    setButlerPickerOpen,
    currentProviderId,
    setCurrentProviderId,
    basicInfoDraft,
    setBasicInfoDraft,
    basicInfoSaving,
    setBasicInfoSaving,
    basicInfoErrors,
    setBasicInfoErrors,
    basicInfoButlerDefault,
    setBasicInfoButlerDefault,
    basicInfoServicePhone,
    setBasicInfoServicePhone,
    basicInfoButlerLoadedForProjectId,
    setBasicInfoButlerLoadedForProjectId,
    vbkLogin,
    setVbkLogin,
    checkingVbkLogin,
    setCheckingVbkLogin,
    vbkLoginAccounts,
    setVbkLoginAccounts,
    loadingLoginAccounts,
    setLoadingLoginAccounts,
    refreshVbkLoginAccounts,
    activeTaskId,
    setActiveTaskId,
    verificationNote,
    setVerificationNote,
    justConfirmedTaskId,
    setJustConfirmedTaskId,
    resolvingVehicleTaskId,
    setResolvingVehicleTaskId,
    navigatingSection,
    setNavigatingSection,
    retryingPhase,
    setRetryingPhase,
    stoppingAutomation,
    setStoppingAutomation,
    notice,
    setNotice,
    aiProvider,
    setAiProvider,
    aiConfigOpen,
    setAiConfigOpen,
    aiBaseUrl,
    setAiBaseUrl,
    aiApiKey,
    setAiApiKey,
    aiModel,
    setAiModel,
    showAiApiKey,
    setShowAiApiKey,
    savingAi,
    setSavingAi,
    testingAi,
    setTestingAi,
    loadingAiKey,
    setLoadingAiKey,
    aiTest,
    setAiTest,
    aiModelList,
    setAiModelList,
    refreshingAiModels,
    setRefreshingAiModels,
    aiModelListError,
    setAiModelListError,
    expandedDayIndex,
    setExpandedDayIndex,
    browserRef,
    conversationRef,
    checkVbkLogin,
    refresh,
    updateReadiness,
  };
}

export type AppStateBase = ReturnType<typeof useAppStateBase>;
