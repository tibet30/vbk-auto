import { useRef, useState } from "react";
import type {
  AccountFixedInfo,
  AccountFixedInfoField,
  AccountFixedInfoValue,
  ContactCardSelection,
  CreateProjectInput,
  MiniMaxConnectionTest,
  ProjectDetail,
  ProjectReadiness,
  ProjectSummary,
  ProviderContactCard,
  Settings as AppSettings,
  VbkLoginStatus,
} from "../../../shared/contracts.js";
import { api, emptyReadiness, initialInput } from "../helpers";

export function useAppStateBase() {
  // 在 Electron 预加载脚本生效之前，window.vbk 可能是 undefined；
  // 路由层靠 apiAvailable 决定是否调用主进程，避免初始化时报警告。
  const apiAvailable = Boolean(api());
  const [view, setView] = useState<"workspace" | "projects" | "settings" | "operation-log">("workspace");
  const [project, setProject] = useState<ProjectDetail | null>(null);
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
  const [contactCards, setContactCards] = useState<ProviderContactCard[]>([]);
  const [contactCardsLoading, setContactCardsLoading] = useState(false);
  const [contactCardSearch, setContactCardSearch] = useState("");

  const [vbkLogin, setVbkLogin] = useState<VbkLoginStatus | null>(null);
  const [checkingVbkLogin, setCheckingVbkLogin] = useState(false);
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

  const [miniMaxConfigOpen, setMiniMaxConfigOpen] = useState(false);
  const [miniMaxBaseUrl, setMiniMaxBaseUrl] = useState("https://api.minimaxi.com/v1");
  const [miniMaxApiKey, setMiniMaxApiKey] = useState("");
  const [showMiniMaxApiKey, setShowMiniMaxApiKey] = useState(false);
  const [savingMiniMax, setSavingMiniMax] = useState(false);
  const [testingMiniMax, setTestingMiniMax] = useState(false);
  const [miniMaxTest, setMiniMaxTest] = useState<MiniMaxConnectionTest | null>(null);

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
    vbkLogin,
    setVbkLogin,
    checkingVbkLogin,
    setCheckingVbkLogin,
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
    miniMaxConfigOpen,
    setMiniMaxConfigOpen,
    miniMaxBaseUrl,
    setMiniMaxBaseUrl,
    miniMaxApiKey,
    setMiniMaxApiKey,
    showMiniMaxApiKey,
    setShowMiniMaxApiKey,
    savingMiniMax,
    setSavingMiniMax,
    testingMiniMax,
    setTestingMiniMax,
    miniMaxTest,
    setMiniMaxTest,
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
