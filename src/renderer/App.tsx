import { type CSSProperties, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Bot, BriefcaseBusiness, CarFront, Check, ChevronDown, ChevronLeft, ChevronRight, CircleCheck, CircleHelp, ClipboardCheck, ExternalLink, Eye, EyeOff, FileText, KeyRound, ListChecks, LoaderCircle, LogIn, PackageOpen, Play, Plus, RefreshCw, Send, Settings, Sparkles, Trash2, TriangleAlert, UserRound } from "lucide-react";
import type { CreateProjectInput, MiniMaxConnectionTest, ProjectDetail, ProjectReadiness, ProjectSummary, Settings as AppSettings, VbkLoginStatus } from "../shared/contracts.js";

type Stage = "review" | "vbk";
type View = "workspace" | "projects" | "settings";

const api = () => window.vbk;
const emptyReadiness: ProjectReadiness = { ready: false, completion: 0, issues: [] };
const initialInput: CreateProjectInput = { destination: "", days: 2, productForm: "privateTour" };

// 切换项目时为新项目选择一个合理的初始阶段；用户可以随后自由切换。
function initialStageFor(status: ProjectSummary["status"] | undefined): Stage {
  if (status === "automating" || status === "draft_saved") return "vbk";
  return "review";
}

function statusLabel(status?: string) { return ({ planning: "方案规划中", review: "等待确认", automating: "正在录入", draft_saved: "草稿已保存", blocked: "需要处理" } as Record<string, string>)[status || ""] || "准备开始"; }
function statusState(status?: ProjectSummary["status"]) { return ({ planning: "researching", review: "needsConfirmation", automating: "researching", draft_saved: "confirmed", blocked: "blocked" } as Record<ProjectSummary["status"], string>)[status || "planning"]; }
function formatUpdatedAt(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "时间未知";
  return date.toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}
function valueOf(source: Record<string, unknown>, key: string) { const value = source[key]; return typeof value === "string" || typeof value === "number" ? String(value) : "待生成"; }
// 去除行程标题里重复出现的 DayN / 第N天 前缀，保留更具语义的副标题。
function stripDayPrefix(title: string, index: number): string {
  const trimmed = title.trim();
  const patterns = [
    new RegExp(`^第\\s*${index + 1}\\s*天[:：、\\s-]*`),
    new RegExp(`^Day\\s*${index + 1}\\s*[:：、\\s-]*`, "i"),
    new RegExp(`^D${index + 1}\\s*[:：、\\s-]*`, "i"),
  ];
  let result = trimmed;
  for (const pattern of patterns) {
    if (pattern.test(result)) {
      result = result.replace(pattern, "");
      break;
    }
  }
  return result.trim() || trimmed;
}
function activityKindLabel(kind: string): string {
  return ({ transport: "交通", visit: "游览", meal: "用餐", hotel: "入住", free: "自由活动", other: "安排" } as Record<string, string>)[kind] || "安排";
}
function isVehicleResourceTask(task?: ProjectDetail["researchTasks"][number]) {
  if (!task) return false;
  return /用车|车辆|车费|资源组|vehicle/i.test(`${task.label} ${task.detail || ""}`);
}
// 项目状态 → 用作第二步"草稿保存"现状文案，避免重复占用 statusLabel 的中文。
function vbkStageStatusText(project: ProjectDetail | null): { tone: "waiting" | "running" | "saved" | "ready" | "blocked"; label: string; detail: string } {
  if (!project) return { tone: "waiting", label: "等待选择项目", detail: "开始一个产品项目后即可进入" };
  const blocked = recoveryNeedsUser(project.automation);
  if (blocked) return { tone: "blocked", label: "已停止，等待处理", detail: "请先在右侧按 MiniMax 给出的指令完成手动操作，再重新发起一次保存草稿" };
  if (project.automation?.status === "running") return { tone: "running", label: "正在录入 VBK", detail: "浏览器自动化进行中，可在右侧观察执行进度" };
  if (project.automation?.status === "succeeded" || project.status === "draft_saved") return { tone: "saved", label: "草稿已保存到 VBK", detail: "提交审核与发布仍需在 VBK 手工完成" };
  return { tone: "waiting", label: "尚未录入 VBK", detail: "第一步审查通过后即可在右侧开始保存草稿" };
}

type RecoveryStageLabel = { phase: string; display: string };

const RECOVERY_PHASE_LABELS: Record<string, string> = {
  basic: "基础信息",
  product: "产品正文",
  itinerary: "每日行程",
  presentation: "产品卖点",
  commercial: "套餐与价格",
  vehicle: "用车资源",
  hotel: "酒店资源",
  cost: "费用项",
};

const DEFAULT_RECOVERY_PHASE_LABEL = (phase: string) => phase || "当前阶段";

function recoveryPhaseDisplay(phase: string): string {
  return RECOVERY_PHASE_LABELS[phase] || DEFAULT_RECOVERY_PHASE_LABEL(phase);
}

interface RecoveryNeedsUser {
  phase: string;
  displayPhase: string;
  instruction: string;
  attempts: Array<{ seq: string; round: 1 | 2; attempt: number; rootCause?: string; expectedEvidence?: string; error: string; action?: string }>;
}

function recoveryNeedsUser(run: ProjectDetail["automation"]): RecoveryNeedsUser | null {
  if (!run?.recovery) return null;
  const block = Object.values(run.recovery.phases).find((rec) => rec.state === "needs_user");
  if (!block) return null;
  // 同一 runner 重入 phase 后，老的 attempts 会被归档到 attemptsHistory；UI
  // 要让运营同时看到两轮的诊断。合并后只保留尾部 3 条，按时间顺序，
  // history (round 1) 在前、current (round 2) 在后。
  const history = (block.attemptsHistory ?? []).map((attempt) => ({
    seq: `第 ${attempt.attempt} 次（历史）`,
    round: 1 as const,
    attempt: attempt.attempt,
    rootCause: attempt.diagnosis?.rootCause,
    expectedEvidence: attempt.diagnosis?.expectedEvidence,
    error: attempt.error,
    action: attempt.action,
  }));
  const current = block.attempts.map((attempt) => ({
    seq: `第 ${attempt.attempt} 次`,
    round: 2 as const,
    attempt: attempt.attempt,
    rootCause: attempt.diagnosis?.rootCause,
    expectedEvidence: attempt.diagnosis?.expectedEvidence,
    error: attempt.error,
    action: attempt.action,
  }));
  const attempts = [...history, ...current].slice(-3);
  return {
    phase: block.phase,
    displayPhase: recoveryPhaseDisplay(block.phase),
    instruction: block.userInstruction || "请在 VBK 手动确认后再次保存草稿。",
    attempts,
  };
}

interface RecoveryAdvisorHint {
  phase: string;
  displayPhase: string;
  currentAttempt: number;
  action?: "advising" | "retrying";
}

function activeAdvisorHint(run: ProjectDetail["automation"]): RecoveryAdvisorHint | null {
  if (!run?.recovery) return null;
  for (const rec of Object.values(run.recovery.phases)) {
    if (rec.state === "advising") {
      const last = rec.attempts[rec.attempts.length - 1];
      return { phase: rec.phase, displayPhase: recoveryPhaseDisplay(rec.phase), currentAttempt: last?.attempt ?? 1, action: "advising" };
    }
    if (rec.state === "retrying") {
      const last = rec.attempts[rec.attempts.length - 1];
      return { phase: rec.phase, displayPhase: recoveryPhaseDisplay(rec.phase), currentAttempt: (last?.attempt ?? rec.attempts.length) + 1, action: "retrying" };
    }
  }
  return null;
}

export function App() {
  const [view, setView] = useState<View>("workspace");
  const [project, setProject] = useState<ProjectDetail | null>(null);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [readiness, setReadiness] = useState<ProjectReadiness>(emptyReadiness);
  const [stage, setStage] = useState<Stage>("review");
  const [input, setInput] = useState("");
  const [createInput, setCreateInput] = useState<CreateProjectInput>(initialInput);
  const [creating, setCreating] = useState(false);
  const [savingProject, setSavingProject] = useState(false);
  const [loading, setLoading] = useState(false);
  const [browserOpen, setBrowserOpen] = useState(false);
  const [loginPanelOpen, setLoginPanelOpen] = useState(false);
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  const [vbkLogin, setVbkLogin] = useState<VbkLoginStatus | null>(null);
  const [checkingVbkLogin, setCheckingVbkLogin] = useState(false);
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null);
  const [verificationNote, setVerificationNote] = useState("");
  const [resolvingVehicleTaskId, setResolvingVehicleTaskId] = useState<string | null>(null);
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
    try { setVbkLogin(await api()!.browser.status(refresh)); }
    catch (error) { setVbkLogin({ loggedIn: false, message: error instanceof Error ? error.message : "无法检测 VBK 登录状态。" }); }
    finally { setCheckingVbkLogin(false); }
  };

  const refresh = async () => {
    if (!api()) return;
    try {
      const next = await api()!.projects.list();
      setProjects(next);
      setProject((current) => current && next.some((item) => item.id === current.id) ? current : null);
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
  useEffect(() => {
    if (!api()) return;
    void refresh();
    void api()!.settings.get().then(setSettings).catch(() => setNotice("无法读取本机设置。"));
    void checkVbkLogin();
    const retryLoginCheck = window.setTimeout(() => void checkVbkLogin(), 1200);
    const unsubscribe = api()!.events.onProjectUpdated((next) => {
      setProject((current) => current?.id === next.id ? next : current);
      void updateReadiness(next);
    });
    return () => { window.clearTimeout(retryLoginCheck); unsubscribe(); };
  }, []);
  useEffect(() => { void updateReadiness(project); }, [project?.id, project?.updatedAt]);
  useEffect(() => { setVerificationNote(""); }, [activeTaskId]);
  // 切换项目时清空核查选择，否则上一个项目残留的 activeTaskId 会落到
  // 新项目的首个待办上，把已输入的核查结果写进另一个项目。
  useEffect(() => {
    if (!project) return;
    setActiveTaskId(null);
    setVerificationNote("");
    setStage(initialStageFor(project.status));
    setExpandedDayIndex(0);
  }, [project?.id]);
  useEffect(() => {
    const conversation = conversationRef.current;
    if (conversation) conversation.scrollTop = conversation.scrollHeight;
  }, [project?.messages.length, loading]);
  // 第二步与登录窗口共享同一个 VBK 浏览器；只有它们需要把 Electron BrowserView
  // 切到可见并设置对应的物理坐标。第一步不渲染嵌入浏览器，避免遮挡会话与审查。
  const browserShouldMount = view === "workspace" && (stage === "vbk" || loginPanelOpen) && Boolean(project || loginPanelOpen);
  useLayoutEffect(() => {
    const target = browserRef.current; if (!target || !api() || !browserShouldMount) return;
    let frame = 0;
    const update = () => {
      const box = target.getBoundingClientRect();
      const width = Math.round(box.width);
      const height = Math.round(box.height);
      if (width <= 0 || height <= 0) return;
      // 主进程的 browser 在窗口加载完成后才创建，早期的布局调用会被拒绝；
      // 这类调用失败不影响使用，静默忽略即可。
      void api()!.browser.setBounds({ x: Math.round(box.x), y: Math.round(box.y), width, height }).catch(() => {});
    };
    const scheduleUpdate = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(update);
    };
    const observer = new ResizeObserver(scheduleUpdate);
    observer.observe(target);
    scheduleUpdate();
    window.addEventListener("resize", scheduleUpdate);
    return () => { window.cancelAnimationFrame(frame); window.removeEventListener("resize", scheduleUpdate); observer.disconnect(); };
  }, [browserShouldMount, loginPanelOpen, stage, view, project?.id]);
  useEffect(() => {
    if (!api()) return;
    void api()!.browser.setVisible(Boolean(view === "workspace" && browserShouldMount)).catch(() => {});
  }, [view, browserShouldMount]);
  useEffect(() => {
    if (view === "workspace" && project && vbkLogin?.loggedIn && stage === "vbk" && !browserOpen) setBrowserOpen(true);
  }, [browserOpen, project, vbkLogin?.loggedIn, view, stage]);

  const itinerary = useMemo(() => project && Array.isArray(project.product.itinerary) ? project.product.itinerary as Array<Record<string, unknown>> : [], [project]);
  const basic = project ? (project.product.basicInfo || {}) as Record<string, unknown> : {};
  const presentation = project ? (project.product.presentation || {}) as Record<string, unknown> : {};
  // 只认当前项目里真实存在的选中项：回退到"首个待办"会让运营在 A 项目
  // 输入的核查结果，落到 B 项目的另一条任务上。
  const activeTask = activeTaskId
    ? project?.researchTasks.find((task) => task.id === activeTaskId)
    : undefined;
  const isVbkLoggedIn = Boolean(vbkLogin?.loggedIn);
  const loggedAccounts = isVbkLoggedIn ? (vbkLogin?.accounts?.length ? vbkLogin.accounts : [vbkLogin?.accountName || "已登录账号"]) : [];
  const currentAccountName = loggedAccounts[0] || "未登录";
  const accountInitial = currentAccountName === "未登录" ? "未" : currentAccountName.slice(0, 1).toUpperCase();
  const browserPlaceholderTitle = isVbkLoggedIn ? "VBK 已登录" : "在 VBK 中完成核查";
  const browserPlaceholderText = isVbkLoggedIn ? `${currentAccountName} 已登录，打开右侧页面继续核查当前待办。` : "登录后先核查当前待办；系统只会在你确认全部待办后保存产品草稿。";
  // 第一步：56% 对话 / 44% 审查；第二步：34% 审查摘要 / 66% VBK 浏览器。
  const splitStyle: CSSProperties | undefined = project
    ? { gridTemplateColumns: stage === "review" ? "minmax(0, 1.27fr) minmax(0, 1fr)" : "minmax(0, 0.515fr) minmax(0, 1fr)" }
    : undefined;
  const projectCompletionLabel = readiness.ready ? "可以录入" : `${readiness.issues.length} 项待处理`;
  const vbkStageStatus = vbkStageStatusText(project);
  const automationActive = project?.automation?.status === "running";
  // needs_user 是失败显示的唯一真值：recovery 优先于通用 status=failed。
  const recoveryBlocked = project?.automation ? recoveryNeedsUser(project.automation) : null;
  const advisorHint = project?.automation ? activeAdvisorHint(project.automation) : null;
  const saveDraftLabel = recoveryBlocked ? "重新开始一轮保存" : "保存草稿";
  // 顶部进度导航把项目就绪度抽象成两个有意义的步骤状态，每个步骤用文字/小点
  // 同时表达含义，不依赖颜色单独传达。
  const reviewStepStatus = !project ? "idle" : readiness.ready ? "passed" : readiness.issues.length ? "inProgress" : "reviewing";
  const vbkStepStatus = !project ? "idle" : vbkStageStatus.tone === "running" ? "inProgress" : vbkStageStatus.tone === "saved" ? "saved" : vbkStageStatus.tone === "blocked" || project.status === "blocked" || readiness.issues.length ? "blocked" : "waiting";

  const send = async (retryContent?: string) => {
    const text = (retryContent || input).trim(); if (!text || !project || loading) return;
    setInput(""); setLoading(true); setNotice(null);
    try { await api()!.ai.send(project.id, text); }
    catch (error) { setNotice(error instanceof Error ? error.message : "方案生成失败，请重试。"); }
    finally { setLoading(false); }
  };
  const createProject = async () => {
    if (!createInput.destination.trim()) { setNotice("请填写目的地。"); return; }
    setSavingProject(true); setNotice(null);
    try {
      const created = await api()!.projects.create({ ...createInput, destination: createInput.destination.trim() });
      setProject(created); setProjects((items) => [created, ...items]); setView("workspace");
    } catch (error) { setNotice(error instanceof Error ? error.message : "创建项目失败，请重试。"); }
    finally { setSavingProject(false); setCreating(false); }
  };
  const deleteProject = async (item: ProjectSummary) => {
    if (!api()) return false;
    setNotice(null);
    try {
      await api()!.projects.delete(item.id);
      setProjects((items) => items.filter((candidate) => candidate.id !== item.id));
      if (project?.id === item.id) setProject(null);
      setNotice(`已删除本机项目「${item.name}」。VBK 平台上的产品未受影响。`);
      return true;
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "删除项目失败，请重试。");
      return false;
    }
  };
  const confirmTask = async () => {
    if (!project || !activeTask) return;
    if (!verificationNote.trim()) { setNotice("请填写在 VBK 或公开来源查到的实际结果，再确认。"); return; }
    setLoading(true);
    try {
      await api()!.research.accept(project.id, activeTask.id, verificationNote.trim());
      await api()!.ai.send(project.id, `运营人员已完成「${activeTask.label}」核查，结果如下：${verificationNote.trim()}。请仅使用这段已核实信息更新产品草稿中对应字段；如仍缺少录入所需数据，请明确保留待核查项。`);
      setVerificationNote(""); setActiveTaskId(null);
    }
    catch (error) { setNotice(error instanceof Error ? error.message : "无法保存核查结果。"); }
    finally { setLoading(false); }
  };
  const resolveVehicleTask = async () => {
    if (!project || !activeTask || resolvingVehicleTaskId) return;
    if (!isVbkLoggedIn) { openLogin(); return; }
    setResolvingVehicleTaskId(activeTask.id); setNotice(null); setBrowserOpen(true);
    try {
      const result = await api()!.research.resolveVehicleResource(project.id, activeTask.id);
      setNotice(`已匹配资源组：${result.resourceGroupName}（ID ${result.resourceGroupId}），估算 ${result.dailyCost} 元/天。`);
      setVerificationNote(""); setActiveTaskId(null);
      void updateReadiness(project);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "用车资源组匹配失败，请在 VBK 手动核查。");
    } finally { setResolvingVehicleTaskId(null); }
  };
  const startAutomation = async () => {
    if (!project || !readiness.ready) return;
    setStage("vbk"); setNotice(null); setBrowserOpen(true); setLoading(true);
    try { await api()!.automation.start(project.id); }
    catch (error) { setNotice(error instanceof Error ? error.message : "自动录入失败，可在 VBK 中检查后重试。"); }
    finally { setLoading(false); }
  };
  const openMiniMaxConfig = async () => {
    setMiniMaxBaseUrl(settings?.minimaxBaseUrl || "https://api.minimaxi.com/v1");
    // 密钥解密失败不能让整个配置入口失效，退回空值让用户重新填写。
    try {
      setMiniMaxApiKey(settings?.hasMiniMaxKey && api() ? await api()!.settings.getApiKey() : "");
    } catch {
      setMiniMaxApiKey("");
      setNotice("已保存的密钥无法读取，请重新填写。");
    }
    setShowMiniMaxApiKey(false);
    setMiniMaxTest(null);
    setMiniMaxConfigOpen(true);
  };
  const saveMiniMaxConfig = async () => {
    const baseUrl = miniMaxBaseUrl.trim(); const apiKey = miniMaxApiKey.trim();
    if (!api()) return;
    if (!baseUrl) { setNotice("请填写 MiniMax 服务地址。"); return; }
    try {
      const url = new URL(baseUrl);
      if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error();
    } catch { setNotice("请输入以 http:// 或 https:// 开头的服务地址。"); return; }
    if (!apiKey && !settings?.hasMiniMaxKey) { setNotice("请填写 MiniMax API Key。"); return; }
    setSavingMiniMax(true); setNotice(null);
    try {
      setSettings(await api()!.settings.save({ minimaxBaseUrl: baseUrl, ...(apiKey ? { apiKey } : {}) }));
      setMiniMaxApiKey(""); setShowMiniMaxApiKey(false); setMiniMaxTest(null); setNotice("MiniMax 配置已保存，请测试连接。");
    } catch (error) { setNotice(error instanceof Error ? error.message : "无法保存 MiniMax 配置。"); }
    finally { setSavingMiniMax(false); }
  };
  const testMiniMaxConnection = async () => {
    const baseUrl = miniMaxBaseUrl.trim(); const apiKey = miniMaxApiKey.trim();
    if (!api()) return;
    if (!baseUrl) { setNotice("请填写 MiniMax 服务地址。"); return; }
    if (!apiKey && !settings?.hasMiniMaxKey) { setNotice("请填写 MiniMax API Key 后再测试。"); return; }
    setTestingMiniMax(true); setMiniMaxTest(null); setNotice(null);
    try {
      const result = await api()!.settings.test({ minimaxBaseUrl: baseUrl, ...(apiKey ? { apiKey } : {}) });
      setMiniMaxTest(result);
    } catch (error) {
      setMiniMaxTest({ connected: false, message: error instanceof Error ? error.message : "MiniMax 连接测试失败。" });
    } finally { setTestingMiniMax(false); }
  };
  const testSavedMiniMaxConnection = async () => {
    if (!api() || !settings?.hasMiniMaxKey) return;
    setTestingMiniMax(true); setMiniMaxTest(null); setNotice(null);
    try { setMiniMaxTest(await api()!.settings.test({ minimaxBaseUrl: settings.minimaxBaseUrl })); }
    catch (error) {
      setMiniMaxTest({ connected: false, message: error instanceof Error ? error.message : "MiniMax 连接测试失败。" });
    } finally { setTestingMiniMax(false); }
  };
  const openLogin = () => {
    setLoginPanelOpen(true); setView("workspace"); setProject(null); setBrowserOpen(true); setVbkLogin(null); setAccountMenuOpen(false); setStage("vbk");
    if (api()) {
      api()!.browser.login()
        .then(() => checkVbkLogin())
        .catch((error) => setVbkLogin({ loggedIn: false, message: error instanceof Error ? error.message : "无法打开 VBK 登录页面。" }));
    }
  };
  const showVbkBrowser = () => {
    setStage("vbk");
    setBrowserOpen(true); setLoginPanelOpen(false);
    void checkVbkLogin(true);
  };
  const logoutVbk = async () => {
    if (!api()) return;
    setCheckingVbkLogin(true); setNotice(null);
    try {
      await api()!.browser.logout();
      setVbkLogin({ loggedIn: false, message: "已退出 VBK。" });
      setBrowserOpen(false); setLoginPanelOpen(false); setAccountMenuOpen(false);
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      setNotice(message.includes("No handler registered")
        ? "登出功能已更新，请重启 VBK Desktop 后再试。"
        : message || "VBK 登出失败，请重试。");
    }
    finally { setCheckingVbkLogin(false); }
  };
  const openProductList = () => { setProject(null); setView("projects"); setCreating(false); setAccountMenuOpen(false); };
  const startCreateProduct = () => { setProject(null); setView("projects"); setCreating(true); setCreateInput(initialInput); setAccountMenuOpen(false); };
  const openStage = (next: Stage) => {
    setStage(next);
    setAccountMenuOpen(false);
  };

  return <div className="app">
    <aside className="rail" aria-label="主导航"><div className="rail-mark">VBK</div><button className="rail-btn" data-active={view === "workspace" && !project} onClick={() => { setProject(null); setView("workspace"); }} aria-label="工作台" title="工作台"><BriefcaseBusiness className="icon" /></button><button className="rail-btn" data-active={view === "projects" || (view === "workspace" && Boolean(project))} onClick={openProductList} aria-label="项目" title="项目"><PackageOpen className="icon" /></button><div className="rail-spacer" /><button className="rail-btn" data-active={view === "settings"} onClick={() => { setProject(null); setView("settings"); }} aria-label="设置" title="设置"><Settings className="icon" /></button><div className="rail-account-wrap"><button className="rail-account" type="button" onClick={() => setAccountMenuOpen((open) => !open)} aria-label={`当前 VBK 账号：${currentAccountName}`} title={currentAccountName}>{accountInitial}</button>{accountMenuOpen && <div className="account-popover"><span className="popover-kicker">当前 VBK</span><strong>{currentAccountName}</strong><button className="btn btn-sm" onClick={openLogin}><UserRound size={14} />切换登录</button>{vbkLogin?.loggedIn && <button className="btn btn-sm" data-variant="ghost" onClick={() => void logoutVbk()} disabled={checkingVbkLogin}>登出</button>}</div>}</div></aside>
    <main className="main">
      <header className="topbar">
      <nav className="topbar-title" aria-label="项目导航">
        {project ? (
          <>
            <button className="crumb crumb-action" onClick={openProductList} aria-label="返回项目列表">
              <span>项目</span>
            </button>
            <ChevronRight size={13} className="crumb-sep" aria-hidden="true" />
            <span className="crumb-current" data-form={project.name.endsWith("跟团游") ? "groupTour" : "privateTour"}>
              <strong className="title">{project.name}</strong>
              <span className="crumb-state" data-state={statusState(project.status)}>
                <span className="dot" data-state={project.status === "blocked" ? "warn" : project.status === "draft_saved" ? "ok" : "ai"} />
                {statusLabel(project.status)}
              </span>
            </span>
          </>
        ) : (
          <span className="crumb">VBK Desktop</span>
        )}
      </nav>
      <div className="topbar-spacer" />
      {project && view === "workspace" && (
        <>
          <div className="topbar-status-chip" aria-label="方案就绪状态">
            <span className="dot" data-state={readiness.ready ? "ok" : readiness.issues.length ? "warn" : "ai"} />
            <strong>{readiness.completion}%</strong>
            <small>·</small>
            <small>{readiness.ready ? "可以录入 VBK" : `${readiness.issues.length} 项待处理`}</small>
          </div>
          <div className="topbar-tool-rail">
            <button
              className="btn btn-sm"
              data-variant="primary"
              disabled={!readiness.ready || loading || automationActive}
              onClick={() => { setStage("vbk"); void startAutomation(); }}
              aria-label={saveDraftLabel}
              title={saveDraftLabel}
            >
              {automationActive ? <LoaderCircle size={14} /> : <Play size={14} />}
              {saveDraftLabel}
            </button>
            <button
              className="topbar-account-chip"
              type="button"
              onClick={() => setAccountMenuOpen((open) => !open)}
              aria-label={`当前 VBK 账号：${currentAccountName}`}
              title={currentAccountName}
            >
              <span className="topbar-account-name">{currentAccountName}</span>
              <span className="dot" data-state={vbkLogin?.loggedIn ? "ok" : "warn"} />
            </button>
          </div>
        </>
      )}
      {!project && (
        <div className="topbar-status">
          <button
            className="topbar-account-chip"
            type="button"
            onClick={() => setAccountMenuOpen((open) => !open)}
            aria-label={`当前 VBK 账号：${currentAccountName}`}
            title={currentAccountName}
          >
            <span className="topbar-account-name">{currentAccountName}</span>
            <span className="dot" data-state={vbkLogin?.loggedIn ? "ok" : "warn"} />
          </button>
          {accountMenuOpen && (
            <div className="account-popover">
              <span className="popover-kicker">当前 VBK</span>
              <strong>{currentAccountName}</strong>
              <button className="btn btn-sm" onClick={openLogin}><UserRound size={14} />切换登录</button>
              {vbkLogin?.loggedIn && (
                <button className="btn btn-sm" data-variant="ghost" onClick={() => void logoutVbk()} disabled={checkingVbkLogin}>登出</button>
              )}
            </div>
          )}
        </div>
      )}
    </header>
      {view === "workspace" && project && (
        <nav className="stage-nav" role="tablist" aria-label="产品工作流步骤">
          <button
            type="button"
            role="tab"
            id="stage-review"
            aria-controls="stage-panel-review"
            aria-selected={stage === "review"}
            tabIndex={stage === "review" ? 0 : -1}
            className="stage-step"
            data-active={stage === "review"}
            data-status={reviewStepStatus}
            onClick={() => openStage("review")}
          >
            <span className="stage-step-index" aria-hidden="true">1</span>
            <span className="stage-step-body">
              <span className="stage-step-title">AI 对话与产品审查</span>
              <span className="stage-step-status" aria-live="polite">
                {!project
                  ? "选择项目后开始"
                  : readiness.ready
                    ? `就绪 ${readiness.completion}% · 可以进入录入`
                    : reviewStepStatus === "reviewing"
                      ? `${readiness.completion}% · 等待 AI 回复`
                      : `还差 ${readiness.issues.length} 项 · 尚未就绪`}
              </span>
            </span>
            <span className={`stage-step-dot dot`} data-state={
              reviewStepStatus === "passed" ? "ok"
              : reviewStepStatus === "inProgress" ? "warn"
              : reviewStepStatus === "reviewing" ? "ai"
              : "idle"
            } aria-hidden="true" />
          </button>
          <span className="stage-connector" aria-hidden="true" data-state={
            reviewStepStatus === "passed" ? "ok"
            : reviewStepStatus === "inProgress" ? "warn"
            : "idle"
          } />
          <button
            type="button"
            role="tab"
            id="stage-vbk"
            aria-controls="stage-panel-vbk"
            aria-selected={stage === "vbk"}
            tabIndex={stage === "vbk" ? 0 : -1}
            className="stage-step"
            data-active={stage === "vbk"}
            data-status={vbkStepStatus}
            onClick={() => openStage("vbk")}
          >
            <span className="stage-step-index" aria-hidden="true">2</span>
            <span className="stage-step-body">
              <span className="stage-step-title">审查结果与 VBK 录入</span>
              <span className="stage-step-status" aria-live="polite">{vbkStageStatus.label} · {vbkStageStatus.detail}</span>
            </span>
            <span className={`stage-step-dot dot`} data-state={
              vbkStageStatus.tone === "saved" ? "ok"
              : vbkStageStatus.tone === "running" ? "ai"
              : reviewStepStatus === "passed" ? "ready"
              : "idle"
            } aria-hidden="true" />
          </button>
          <span className="stage-nav-spacer" aria-hidden="true" />
          <span className="stage-nav-summary" aria-label="当前步骤概要">
            {stage === "review" ? (
              <>
                <Sparkles size={14} />
                <span>{projectCompletionLabel}</span>
              </>
            ) : (
              <>
                {vbkStageStatus.tone === "saved" ? <Check size={14} /> : vbkStageStatus.tone === "running" ? <LoaderCircle size={14} /> : <CircleHelp size={14} />}
                <span>{vbkStageStatus.label}</span>
              </>
            )}
          </span>
        </nav>
      )}
      {notice && <div className="notice" role="status"><TriangleAlert size={15} /><span>{notice}</span><button onClick={() => setNotice(null)}>关闭</button></div>}
      {view === "settings" && !project && <section className="view"><div className="view-container narrow settings-page"><header className="settings-page-head"><div><h1 className="view-h1">设置</h1><p className="view-sub">连接配置和 VBK 登录状态都在这里管理。</p></div></header><div className="settings-stack">
        <section className="settings-block">
          <div className="settings-block-head">
            <span className="settings-block-icon"><KeyRound size={17} /></span>
            <div className="settings-block-head-body">
              <strong>连接设置</strong>
              <small>MiniMax 用于生成产品方案和后续调整。</small>
            </div>
          </div>
          <div className="settings-block-body">
            <div className="account-list">
              <div className="account-row">
                <span className="account-avatar" data-source="minimax">M</span>
                <span className="account-row-info">
                  <strong>MiniMax</strong>
                  <small>{settings?.hasMiniMaxKey ? `已连接 ${settings.minimaxBaseUrl}` : "尚未配置 API Key。"}</small>
                </span>
                <div className="account-actions">
                  <span className="state" data-state={settings?.hasMiniMaxKey ? "current" : "needsConfirmation"}>{settings?.hasMiniMaxKey ? "已连接" : "未配置"}</span>
                  {settings?.hasMiniMaxKey && (
                    <button className="icon-btn" data-size="sm" type="button" onClick={() => void testSavedMiniMaxConnection()} disabled={testingMiniMax} aria-label="重新测试 MiniMax 连接" title="重新测试连接">{testingMiniMax ? <LoaderCircle size={14} /> : <RefreshCw size={14} />}</button>
                  )}
                  <button className="btn btn-sm" data-variant={settings?.hasMiniMaxKey ? "secondary" : "ai"} onClick={() => miniMaxConfigOpen ? setMiniMaxConfigOpen(false) : void openMiniMaxConfig()}>
                    {miniMaxConfigOpen ? "收起配置" : settings?.hasMiniMaxKey ? "更新配置" : "配置连接"}
                  </button>
                </div>
              </div>
            </div>
            {miniMaxTest && !miniMaxConfigOpen && <p className="field-hint" data-state={miniMaxTest.connected ? "confirmed" : "blocked"}>{miniMaxTest.message}</p>}
            {miniMaxConfigOpen && (
              <form className="minimax-config-form" onSubmit={(event) => { event.preventDefault(); void saveMiniMaxConfig(); }}>
                <label><span className="field-label">服务地址</span><input className="input mono" type="url" inputMode="url" autoComplete="url" placeholder="https://api.minimaxi.com/v1" value={miniMaxBaseUrl} onChange={(event) => { setMiniMaxBaseUrl(event.target.value); setMiniMaxTest(null); }} /></label>
                <label><span className="field-label">API Key</span><span className="secret-input"><input className="input" type={showMiniMaxApiKey ? "text" : "password"} autoComplete="off" placeholder={settings?.hasMiniMaxKey ? "已保存；留空则使用已保存的 Key" : "请输入 MiniMax API Key"} value={miniMaxApiKey} onChange={(event) => { setMiniMaxApiKey(event.target.value); setMiniMaxTest(null); }} /><button className="secret-toggle" type="button" onClick={() => setShowMiniMaxApiKey((visible) => !visible)} aria-label={showMiniMaxApiKey ? "隐藏 API Key" : "显示 API Key"} aria-pressed={showMiniMaxApiKey}>{showMiniMaxApiKey ? <Eye size={16} /> : <EyeOff size={16} />}</button></span><small className="field-hint">已保存的 Key 会回填到此处，默认保持隐藏；测试不会保存新输入的 Key。</small></label>
                {miniMaxTest && <p className="field-hint" data-state={miniMaxTest.connected ? "confirmed" : "blocked"}>{miniMaxTest.message}</p>}
                <div className="form-actions">
                  <button className="btn" type="button" data-variant="ghost" onClick={() => { setMiniMaxConfigOpen(false); setMiniMaxApiKey(""); setShowMiniMaxApiKey(false); setMiniMaxTest(null); }}>取消</button>
                  <button className="btn" type="button" onClick={() => void testMiniMaxConnection()} disabled={testingMiniMax}>{testingMiniMax ? <LoaderCircle size={15} /> : null}测试连接</button>
                  <button className="btn" type="submit" data-variant="ai" disabled={savingMiniMax}>{savingMiniMax ? <LoaderCircle size={15} /> : null}保存配置</button>
                </div>
              </form>
            )}
          </div>
        </section>
        <section className="settings-block">
          <div className="settings-block-head">
            <span className="settings-block-icon"><UserRound size={17} /></span>
            <div className="settings-block-head-body">
              <strong>VBK 登录设置</strong>
              <small>已登录账号会显示在列表里，登录态只保存在本机。</small>
            </div>
          </div>
          <div className="settings-block-body">
            <div className="account-list">
              {loggedAccounts.length ? loggedAccounts.map((name) => (
                <div className="account-row" key={name}>
                  <span className="account-avatar">{name.slice(0, 1).toUpperCase()}</span>
                  <span className="account-row-info">
                    <strong>{name}</strong>
                    <small>已登录 VBK</small>
                  </span>
                  <div className="account-actions">
                    <span className="state" data-state="current">当前</span>
                    <button className="icon-btn" data-size="sm" type="button" onClick={() => void checkVbkLogin(true)} disabled={checkingVbkLogin} aria-label="刷新 VBK 登录状态" title="刷新登录状态">{checkingVbkLogin ? <LoaderCircle size={14} /> : <RefreshCw size={14} />}</button>
                    <button className="btn btn-sm" data-variant="danger" onClick={() => void logoutVbk()} disabled={checkingVbkLogin}>登出</button>
                  </div>
                </div>
              )) : (
                <div className="account-row" data-empty="true">
                  <span className="account-avatar">未</span>
                  <span className="account-row-info">
                    <strong>暂无已登录账号</strong>
                    <small>{checkingVbkLogin ? "正在检查登录状态" : "新增登录后会出现在这里"}</small>
                  </span>
                  <div className="account-actions">
                    <button className="icon-btn" data-size="sm" type="button" onClick={() => void checkVbkLogin(true)} disabled={checkingVbkLogin} aria-label="刷新 VBK 登录状态" title="刷新登录状态">{checkingVbkLogin ? <LoaderCircle size={14} /> : <RefreshCw size={14} />}</button>
                    <button className="btn btn-sm" data-variant="secondary" onClick={openLogin}><LogIn size={14} />新增登录VBK</button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </section>
      </div></div></section>}
      {view === "projects" && !project && <section className="view projects-view"><div className="view-container content-width project-view-container"><div className="project-page-head"><div><h1 className="view-h1">项目</h1><p className="view-sub">管理产品草稿、规划进度和录入状态。</p></div><button className="btn" data-variant="primary" onClick={startCreateProduct}><Plus size={16} />新建产品</button></div>{creating && <ProductBriefForm input={createInput} setInput={setCreateInput} submitting={savingProject} onCancel={() => setCreating(false)} onSubmit={() => void createProject()} />}{projects.length ? <ProjectList projects={projects} onOpen={async (item) => { const next = await api()!.projects.get(item.id); setProject(next); setView("workspace"); }} onDelete={deleteProject} /> : !creating && <EmptyProjectState onCreate={startCreateProduct} />}</div></section>}
      {view === "workspace" && !project && <section className="view login-stage" data-login-open={loginPanelOpen}>
        <div className="view-container content-width workspace-home">
          <div className="home-head"><div><h1 className="view-h1">工作台</h1><p className="view-sub">只保留日常操作必须入口：AI 连接、VBK 登录和产品项目。</p></div><button className="btn" data-variant="primary" onClick={startCreateProduct}><Plus size={16} />新建产品</button></div>
          <div className="module-grid"><WorkbenchModule icon={<Sparkles size={18} />} title="MiniMax" detail={settings?.hasMiniMaxKey ? "连接已配置，可生成方案" : "未配置 API Key"} state={settings?.hasMiniMaxKey ? "ready" : "todo"} action={settings?.hasMiniMaxKey ? <button className="btn btn-sm" onClick={() => void testSavedMiniMaxConnection()}>{testingMiniMax ? <LoaderCircle size={14} /> : <Check size={14} />}测试</button> : <button className="btn btn-sm" data-variant="ai" onClick={() => { setView("settings"); void openMiniMaxConfig(); }}>配置</button>} /><WorkbenchModule icon={<LogIn size={18} />} title="VBK" detail={vbkLogin?.loggedIn ? `${currentAccountName} 已登录` : checkingVbkLogin ? "正在检测登录状态" : "需要登录后核查和保存草稿"} state={vbkLogin?.loggedIn ? "ready" : "todo"} action={vbkLogin?.loggedIn ? <button className="btn btn-sm" onClick={() => void checkVbkLogin(true)}><RefreshCw size={14} />刷新</button> : <button className="btn btn-sm" onClick={openLogin}><LogIn size={14} />登录</button>} /><WorkbenchModule icon={<PackageOpen size={18} />} title="产品" detail={`${projects.length} 个产品项目`} state={projects.length ? "ready" : "todo"} action={<button className="btn btn-sm" onClick={openProductList}>进入列表</button>} /></div>
          <section className="quick-panel"><div><strong>产品快捷入口</strong><small>新建产品后会直接进入产品详情；详情面包屑可返回项目列表。</small></div><div className="quick-actions"><button className="btn" data-variant="primary" onClick={startCreateProduct}><Plus size={15} />新建产品</button><button className="btn" onClick={openProductList}><FileText size={15} />产品列表</button>{projects[0] && <button className="btn" data-variant="ghost" onClick={async () => { const next = await api()!.projects.get(projects[0].id); setProject(next); setView("workspace"); }}>进入最近产品</button>}</div></section>
        </div>
        {loginPanelOpen && <section className="login-browser" aria-label="VBK 登录窗口"><div className="browser-chrome"><div className="browser-url"><span className="host">vbooking.ctrip.com</span><span className="path">/登录</span></div><button className="icon-btn" type="button" onClick={() => void checkVbkLogin(true)} disabled={checkingVbkLogin} aria-label="刷新 VBK 登录状态" title="刷新登录状态">{checkingVbkLogin ? <LoaderCircle size={16} /> : <RefreshCw size={16} />}</button><button className="icon-btn" type="button" onClick={() => { setLoginPanelOpen(false); setBrowserOpen(false); }} aria-label="关闭登录窗口" title="关闭">×</button></div><div className="browser-viewport" ref={browserRef} /></section>}
      </section>}
      {view === "workspace" && project && (
        <section
          className="workflow-stage"
          data-stage={stage}
          role="tabpanel"
          id={`stage-panel-${stage}`}
          aria-labelledby={`stage-${stage}`}
        >
          {stage === "review" ? (
            <div className="stage-split review-split" style={splitStyle}>
              <section className="panel ai" aria-label="方案协作">
                <div className="panel-header">
                  <div className="panel-title-row"><span className="panel-num">01</span><strong className="panel-title">方案协作</strong></div>
                  <span className="panel-sub-line">{project.messages.length} 条对话 · {loading ? "等待 AI" : "可继续追问"}</span>
                </div>
                <div className="conversation" ref={conversationRef} role="log" aria-live="polite">{project.messages.map((message, index) => {
                  const retryContent = message.role === "assistant" && message.taskStatus === "failed" ? project.messages.slice(0, index).reverse().find((item) => item.role === "user")?.content : undefined;
                  return <article className="msg" data-role={message.role} data-state={message.taskStatus} key={message.id}><span className="msg-avatar">{message.role === "assistant" ? <Bot size={14} /> : message.role === "system" ? <TriangleAlert size={14} /> : "我"}</span><div className="msg-body"><div className="msg-content"><p>{message.content}</p></div><small className="msg-meta">{new Date(message.createdAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}{message.role === "user" && message.taskStatus === "running" && <><span>·</span><span className="msg-progress"><LoaderCircle size={12} />正在等待 AI 回复</span></>}{message.taskStatus === "failed" && <><span>·</span><span className="msg-error">本轮未完成</span></>}</small>{retryContent && <button className="msg-retry" type="button" onClick={() => void send(retryContent)} disabled={loading}><RefreshCw size={13} />重新发送这条消息</button>}</div></article>;
                })}{loading && <div className="ai-thinking" role="status"><Bot size={14} /><span>AI 正在生成回复…</span></div>}</div>
                <div className="composer">
                  <div className="composer-card">
                    <textarea
                      className="composer-textarea"
                      placeholder="例如：把这个产品改成亲子主题；或：在右侧浏览器里核查 XX 资源组后，把结果告诉我…"
                      value={input}
                      onChange={(event) => setInput(event.target.value)}
                      onKeyDown={(event) => { if ((event.metaKey || event.ctrlKey) && event.key === "Enter") void send(); }}
                      disabled={loading}
                      aria-label="方案协作输入"
                    />
                    <div className="composer-bar">
                      <div className="composer-bar-left">
                        <span className="panel-sub-line">项目上下文已带入，资源、价格必须经 VBK 核查后再回复。</span>
                      </div>
                      <div className="composer-bar-right">
                        <span className="chip-mini" data-on={Boolean(input.trim())}>
                          <kbd className="kbd">⌘</kbd><kbd className="kbd">↵</kbd>
                        </span>
                        <button
                          className="composer-send"
                          type="button"
                          aria-label="发送消息，Command 加回车可快速发送"
                          aria-disabled={loading || !input.trim()}
                          data-disabled={loading || !input.trim()}
                          onClick={() => void send()}
                          disabled={loading}
                        >
                          {loading ? <LoaderCircle size={15} /> : <Send size={15} />}
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              </section>
              <section className="panel product" aria-label="产品审查">
                <div className="panel-header">
                  <div className="panel-title-row"><span className="panel-num">02</span><strong className="panel-title">产品审查</strong></div>
                  <span className="state" data-state={readiness.ready ? "confirmed" : "needsConfirmation"}>{readiness.ready ? "可以录入" : `${readiness.issues.length} 项待处理`}</span>
                </div>
                <div className="product-scroll">
                  <div className="readiness-hero" data-ready={readiness.ready}>
                    <div className="readiness-hero-icon">{readiness.ready ? <Check size={18} /> : <CircleHelp size={18} />}</div>
                    <div className="readiness-hero-body">
                      <strong>{readiness.ready ? "方案满足录入条件" : "下一步：先完成待核查项目"}</strong>
                      <small>{readiness.ready ? "确认后将自动填写 VBK 并保存为草稿，不会提审或发布。" : "第一版方案已经生成；解决下方高优先级问题后即可保存 VBK 草稿。"}</small>
                    </div>
                    <div className="readiness-hero-progress">
                      <strong>{readiness.completion}%</strong>
                      <small>就绪度</small>
                    </div>
                  </div>
                  {!readiness.ready && (
                    <div className="readiness-chips" data-empty={readiness.issues.length === 0}>
                      {readiness.issues.slice(0, 4).map((issue, index) => (
                        <span className="readiness-chip" key={`${issue.label}-${index}`} data-priority={index === 0 ? "high" : "medium"}>
                          <span className="check"><TriangleAlert size={11} /></span>
                          {formatIssueLabel(issue.label)}
                        </span>
                      ))}
                      {readiness.issues.length > 4 && <span className="readiness-chip" data-priority="medium">还有 {readiness.issues.length - 4} 项</span>}
                    </div>
                  )}
                  <section className="product-section">
                    <div className="product-section-head">
                      <span className="panel-num">A</span>
                      <strong className="product-section-title">基础信息</strong>
                    </div>
                    <div className="product-grid product-grid-basic">
                      <Field label="产品名称" value={valueOf(basic, "supplierProductName")} />
                      <Field label="集合城市" value={valueOf(basic, "meetingCity")} />
                      <Field label="目的城市" value={valueOf(basic, "destinationCity")} />
                      <Field label="行程规格" value={`${valueOf(basic, "days")} 天 ${valueOf(basic, "nights")} 晚`} />
                    </div>
                  </section>
                  <section className="product-section">
                    <div className="product-section-head">
                      <span className="panel-num">B</span>
                      <strong className="product-section-title">每日行程</strong>
                      <span className="product-section-meta">{itinerary.length} 天</span>
                    </div>
                    {itinerary.length ? (
                      <div className="product-itinerary">
                        {itinerary.map((day, index) => {
                          const spots = Array.isArray(day.spots) ? (day.spots as unknown[]).map((spot) => String(spot)).filter(Boolean) : [];
                          const activities = Array.isArray(day.activities) ? day.activities as Array<{ time?: string; title?: string; detail?: string; type?: string }> : [];
                          const description = typeof day.description === "string" ? day.description.trim() : "";
                          const meals = typeof day.meals === "string" ? day.meals.trim() : "";
                          const hotel = typeof day.hotel === "string" ? day.hotel.trim() : "";
                          const rawTitle = valueOf(day, "title");
                          const displayTitle = stripDayPrefix(rawTitle, index);
                          const spotSummary = spots.length ? spots.slice(0, 3).join(" · ") + (spots.length > 3 ? " …" : "") : "待补充景点";
                          const expanded = expandedDayIndex === index;
                          const contentId = `itinerary-day-${index}`;
                          return (
                            <div className="itinerary-card" key={index} data-expanded={expanded}>
                              <button
                                className="itinerary-card-trigger"
                                type="button"
                                aria-expanded={expanded}
                                aria-controls={contentId}
                                onClick={() => setExpandedDayIndex(expanded ? null : index)}
                              >
                                <span className="itinerary-day-badge">D{index + 1}</span>
                                <span className="itinerary-card-summary">
                                  <strong>{displayTitle}</strong>
                                  <span>{spotSummary}</span>
                                </span>
                                <span className="itinerary-card-count">{spots.length ? `${spots.length} 个景点` : "行程待补充"}</span>
                                <ChevronDown size={14} className="itinerary-card-chevron" aria-hidden="true" />
                              </button>
                              {expanded && (
                                <div className="itinerary-card-content" id={contentId} role="region" aria-label={`第 ${index + 1} 天行程`}>
                                  {activities.length ? (
                                    <ol className="itinerary-timeline">
                                      {activities.map((activity, activityIndex) => {
                                        const kind = typeof activity.type === "string" ? activity.type : "other";
                                        const time = typeof activity.time === "string" && activity.time ? activity.time : "—";
                                        const title = typeof activity.title === "string" && activity.title ? activity.title : activityKindLabel(kind);
                                        const detail = typeof activity.detail === "string" ? activity.detail : "";
                                        return (
                                          <li className="itinerary-timeline-item" data-kind={kind} key={activityIndex}>
                                            <time>{time}</time>
                                            <span className="itinerary-timeline-rail" aria-hidden="true"><span /></span>
                                            <div className="itinerary-timeline-copy">
                                              <div className="itinerary-timeline-heading">
                                                <strong>{title}</strong>
                                                <small>{activityKindLabel(kind)}</small>
                                              </div>
                                              {detail && <p>{detail}</p>}
                                            </div>
                                          </li>
                                        );
                                      })}
                                    </ol>
                                  ) : spots.length || description ? (
                                    <div className="itinerary-timeline">
                                      {spots.map((spot, spotIndex) => (
                                        <div className="itinerary-timeline-item" data-kind="visit" key={`spot-${spotIndex}`}>
                                          <span className="itinerary-timeline-label">第 {spotIndex + 1} 站</span>
                                          <span className="itinerary-timeline-rail" aria-hidden="true"><span /></span>
                                          <div className="itinerary-timeline-copy">
                                            <div className="itinerary-timeline-heading">
                                              <strong>{spot}</strong>
                                              <small>游览</small>
                                            </div>
                                          </div>
                                        </div>
                                      ))}
                                      {description && <p className="itinerary-day-description">{description}</p>}
                                    </div>
                                  ) : (
                                    <p className="itinerary-day-empty">这一天还没有具体安排，等待 AI 补全。</p>
                                  )}
                                  <div className="itinerary-day-facts">
                                    <span>
                                      <small>餐食</small>
                                      <span>{meals || "餐食信息待核查"}</span>
                                    </span>
                                    <span>
                                      <small>住宿</small>
                                      <span>{hotel || "住宿信息待核查"}</span>
                                    </span>
                                  </div>
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    ) : (
                      <p className="section-empty">正在等待 AI 生成第一版行程。</p>
                    )}
                  </section>
                  <section className="product-section">
                    <div className="product-section-head">
                      <span className="panel-num">C</span>
                      <strong className="product-section-title">产品卖点</strong>
                    </div>
                    <div className="review-copy">
                      <div className="review-copy-block">
                        <span className="review-copy-kicker">面向客人的推荐语</span>
                        <strong className="review-copy-rec">{valueOf(presentation, "recommendation")}</strong>
                      </div>
                      <div className="review-copy-block">
                        <span className="review-copy-kicker">产品特点</span>
                        <p className="review-copy-feat">{valueOf(presentation, "features")}</p>
                      </div>
                      <div className="review-copy-block">
                        <span className="review-copy-kicker">推荐理由（3 条）</span>
                        {Array.isArray(presentation.recommendations) && presentation.recommendations.length === 3 ? (
                          <ul className="review-copy-reasons">
                            {(presentation.recommendations as Array<{ category: string; text: string }>).map((r, index) => (
                              <li key={index}>
                                <strong>{r.category}</strong>
                                <span>{r.text}</span>
                              </li>
                            ))}
                          </ul>
                        ) : (
                          <p className="section-empty">正在等待 AI 生成推荐理由…</p>
                        )}
                      </div>
                    </div>
                  </section>
                  <section className="product-section">
                    <div className="product-section-head">
                      <span className="panel-num">D</span>
                      <strong className="product-section-title">录入前检查</strong>
                      <span className="product-section-meta">{readiness.issues.length === 0 ? "已通过" : `还需 ${readiness.issues.length} 项`}</span>
                    </div>
                    {readiness.issues.length === 0 ? (
                      <div className="review-checklist-empty">
                        <Check size={14} /><span>通过完整性检查，可以保存 VBK 草稿。</span>
                      </div>
                    ) : (
                      <div className="review-checklist">
                        <div className="review-checklist-head">
                          <strong>{readiness.issues.length} 项待处理</strong>
                          <small>按优先级排列；解决高优先级项后即可保存 VBK 草稿。</small>
                        </div>
                        <ul className="review-checklist-list">
                          {readiness.issues.map((issue, index) => {
                            const { guidance } = formatIssueGuidance(issue);
                            return (
                              <li
                                className="review-checklist-item"
                                key={`${issue.label}-${index}`}
                                data-priority={index === 0 ? "high" : "medium"}
                              >
                                <span className="review-checklist-index">{index + 1}</span>
                                <span className="review-checklist-body">
                                  <strong className="review-checklist-label">{formatIssueLabel(issue.label)}</strong>
                                  <span className="review-checklist-guidance">{guidance}</span>
                                </span>
                              </li>
                            );
                          })}
                        </ul>
                      </div>
                    )}
                  </section>
                </div>
                <footer className="product-footer">
                  <span className="product-footer-meta">
                    <strong>{readiness.ready ? "✓ 已通过" : "⏳ 进行中"}</strong>
                    {readiness.ready ? " 可保存 VBK 草稿" : ` 还需 ${readiness.issues.length} 项核查`}
                  </span>
                  <button
                    className="btn btn-lg"
                    data-variant="primary"
                    disabled={!readiness.ready || loading}
                    onClick={() => { setStage("vbk"); void startAutomation(); }}
                  >
                    <CircleCheck size={15} />前往 VBK 录入
                  </button>
                </footer>
              </section>
            </div>
          ) : (
            <div className="stage-split vbk-split" style={splitStyle}>
              <aside className="panel review-summary" aria-label="审查结果概要">
                <div className="panel-header">
                  <div className="panel-title-row"><span className="panel-num">02</span><strong className="panel-title">审查结果</strong></div>
                  <span className="state" data-state={readiness.ready ? "confirmed" : "needsConfirmation"}>{readiness.ready ? "可以录入" : `${readiness.issues.length} 项待处理`}</span>
                </div>
                <div className="product-scroll">
                  <div className="readiness-hero" data-ready={readiness.ready}>
                    <div className="readiness-hero-icon">{readiness.ready ? <Check size={18} /> : <TriangleAlert size={18} />}</div>
                    <div className="readiness-hero-body">
                      <strong>{readiness.ready ? "产品方案已就绪" : "先回第一步完成审查"}</strong>
                      <small>
                        {readiness.ready
                          ? "在右侧浏览器执行录入，系统只保存 VBK 草稿，不会提审或发布。"
                          : `还有 ${readiness.issues.length} 项未解决；保存草稿将保持禁用。`}
                      </small>
                    </div>
                    <div className="readiness-hero-progress">
                      <strong>{readiness.completion}%</strong>
                      <small>就绪度</small>
                    </div>
                  </div>
                  {!readiness.ready && (
                    <div className="review-checklist">
                      <div className="review-checklist-head">
                        <strong>{readiness.issues.length} 项待处理</strong>
                        <small>先在第一步里完成核查，再回到这里继续。</small>
                      </div>
                      <ul className="review-checklist-list">
                        {readiness.issues.slice(0, 4).map((issue, index) => {
                          const { guidance } = formatIssueGuidance(issue);
                          return (
                            <li
                              className="review-checklist-item"
                              key={`${issue.label}-${index}`}
                              data-priority={index === 0 ? "high" : "medium"}
                            >
                              <span className="review-checklist-index">{index + 1}</span>
                              <span className="review-checklist-body">
                                <strong className="review-checklist-label">{formatIssueLabel(issue.label)}</strong>
                                <span className="review-checklist-guidance">{guidance}</span>
                              </span>
                            </li>
                          );
                        })}
                        {readiness.issues.length > 4 && (
                          <li className="review-checklist-item" data-priority="medium">
                            <span className="review-checklist-index">…</span>
                            <span className="review-checklist-body">
                              <strong className="review-checklist-label">还有 {readiness.issues.length - 4} 项</strong>
                              <span className="review-checklist-guidance">回到第一步的产品审查面板查看完整列表。</span>
                            </span>
                          </li>
                        )}
                      </ul>
                    </div>
                  )}
                  <section className="product-section">
                    <div className="product-section-head">
                      <span className="panel-num">B</span>
                      <strong className="product-section-title">核查任务</strong>
                      <span className="product-section-meta">
                        {project.researchTasks.filter((t) => t.state === "confirmed" || t.state === "resolved").length}/{project.researchTasks.length || 0} 已确认
                      </span>
                    </div>
                    {project.researchTasks.length ? (
                      <ul className="review-checklist-list">
                        {project.researchTasks.map((task) => (
                          <li
                            className="review-checklist-item"
                            key={task.id}
                            data-priority={task.state === "confirmed" || task.state === "resolved" ? "low" : "medium"}
                          >
                            <span className="review-checklist-index">
                              {task.state === "confirmed" || task.state === "resolved" ? <Check size={12} /> : <CircleHelp size={12} />}
                            </span>
                            <span className="review-checklist-body">
                              <strong className="review-checklist-label">{task.label}</strong>
                              <span className="review-checklist-guidance">{task.detail || "需要核查"}</span>
                            </span>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="section-empty">暂无待核查任务；项目结构简单，可直接保存草稿。</p>
                    )}
                  </section>
                  {project.automation && (
                    <section className="product-section">
                      <div className="product-section-head">
                        <span className="panel-num">C</span>
                        <strong className="product-section-title">自动录入进度</strong>
                        <span className="state" data-state={recoveryBlocked ? "blocked" : project.automation.status === "succeeded" ? "confirmed" : project.automation.status === "failed" ? "blocked" : "researching"}>
                          {recoveryBlocked ? "需要处理" : project.automation.status === "succeeded" ? "草稿已保存" : project.automation.status === "failed" ? "录入失败" : "执行中"}
                        </span>
                      </div>
                      <div className="automation">
                        <div className="automation-body">
                          {project.automation.phases.map((phase) => {
                            const rec = project.automation?.recovery?.phases[phase.phase];
                            const stageState = recoveryBlocked && rec?.state === "needs_user"
                              ? "failed"
                              : rec?.state === "advising" || rec?.state === "retrying"
                                ? "running"
                                : phase.status === "completed" ? "done" : phase.status === "running" ? "running" : phase.status === "failed" ? "failed" : "pending";
                            return (
                              <div className="stage" data-state={stageState} key={phase.phase}>
                                <span className="stage-dot" />
                                <span className="stage-label">{recoveryPhaseDisplay(phase.phase)}</span>
                              </div>
                            );
                          })}
                          {advisorHint && (
                            <div className="recovery-banner" data-state="advising" role="status" aria-live="polite">
                              <LoaderCircle size={14} aria-hidden="true" />
                              <span>
                                {advisorHint.action === "retrying"
                                  ? `MiniMax 将按建议进行第 ${advisorHint.currentAttempt} 次尝试（${advisorHint.displayPhase}）`
                                  : `正在诊断「${advisorHint.displayPhase}」第 ${advisorHint.currentAttempt} 次失败`}
                              </span>
                            </div>
                          )}
                          {recoveryBlocked && (
                            <div className="recovery-banner" data-state="needs_user" role="alert" aria-live="assertive">
                              <TriangleAlert size={14} aria-hidden="true" />
                              <div className="recovery-banner-body">
                                <strong>已停止，等待用户处理：{recoveryBlocked.displayPhase}</strong>
                                <p className="recovery-banner-instruction">{recoveryBlocked.instruction}</p>
                                {recoveryBlocked.attempts.length > 0 ? (
                                  <ol className="recovery-attempts">
                                    {recoveryBlocked.attempts.map((attempt) => {
                                      // seq 区分历史轮 vs 当前轮；list 末尾的 attempt
                                      // 才是“最近一次失败”，之前都属于历史。
                                      const isLatest = attempt.seq === recoveryBlocked.attempts[recoveryBlocked.attempts.length - 1].seq;
                                      return (
                                      <li key={`${attempt.round}-${attempt.attempt}-${attempt.seq}`} className="recovery-attempt" data-state={isLatest ? "latest" : "history"} data-round={attempt.round}>
                                        <span className="recovery-attempt-index">{attempt.seq}</span>
                                        {attempt.rootCause ? (
                                          <span className="recovery-attempt-cause">{attempt.rootCause}</span>
                                        ) : (
                                          <span className="recovery-attempt-cause muted">暂无 MiniMax 诊断</span>
                                        )}
                                        {attempt.expectedEvidence && (
                                          <span className="recovery-attempt-evidence">预期证据：{attempt.expectedEvidence}</span>
                                        )}
                                        <code className="recovery-attempt-error">{attempt.error}</code>
                                      </li>
                                    );
                                    })}
                                  </ol>
                                ) : (
                                  <p className="recovery-banner-instruction">本次没有保留可显示的诊断记录，请在右侧浏览器内手动完成后再次保存草稿。</p>
                                )}
                              </div>
                            </div>
                          )}
                          <p className="automation-note">只保存草稿，不提交审核或发布。</p>
                        </div>
                      </div>
                    </section>
                  )}
                  <div className="review-safety">
                    <ShieldCheck size={14} aria-hidden="true" />
                    <span>系统只保存 VBK 草稿，不会替运营提交审核或发布，操作人始终拥有最终决定权。</span>
                  </div>
                </div>
                <footer className="product-footer">
                  <span className="product-footer-meta">
                    <strong>{readiness.ready ? "✓ 已通过" : "⏳ 进行中"}</strong>
                    {readiness.ready ? " 可保存 VBK 草稿" : ` 还需 ${readiness.issues.length} 项核查`}
                  </span>
                  <button className="btn btn-lg" data-variant="primary" disabled={!readiness.ready || loading || automationActive} onClick={() => void startAutomation()}>
                    {automationActive ? <LoaderCircle size={15} /> : <Play size={15} />}
                    {saveDraftLabel}
                  </button>
                </footer>
              </aside>
              <section className="panel browser" aria-label="VBK 浏览器">
                <div className="panel-header">
                  <div className="panel-title-row"><span className="panel-num">03</span><strong className="panel-title">VBK 浏览器</strong></div>
                  <span className="panel-sub-line">
                    <span className={`dot`} data-state={isVbkLoggedIn ? "ok" : "warn"} />
                    {isVbkLoggedIn ? `已登录 ${currentAccountName}` : "未登录 VBK"}
                  </span>
                </div>
                <div className="browser-panel-head">
                  <div className="browser-nav">
                    <button className="icon-btn" data-size="sm" aria-label="返回"><ChevronLeft size={14} /></button>
                  </div>
                  <div className="browser-url"><span className="host">vbooking.ctrip.com</span><span className="path">/产品库</span></div>
                  <div className="browser-actions">
                    <button className="icon-btn" data-size="sm" aria-label="刷新" onClick={showVbkBrowser}><RefreshCw size={14} /></button>
                    <button className="icon-btn" data-size="sm" aria-label="打开外部浏览器"><ExternalLink size={14} /></button>
                  </div>
                </div>
                <div className="browser-viewport" ref={browserRef}>
                  {!browserOpen && (
                    <div className="browser-placeholder">
                      <div className="browser-placeholder-card">
                        {isVbkLoggedIn ? <Check size={22} /> : <LogIn size={22} />}
                        <h4>{browserPlaceholderTitle}</h4>
                        <p>{browserPlaceholderText}</p>
                        <div className="btn-row">
                          {isVbkLoggedIn
                            ? <button className="btn" data-variant="primary" onClick={showVbkBrowser}><RefreshCw size={15} />显示浏览器</button>
                            : <button className="btn" data-variant="primary" onClick={openLogin}><LogIn size={15} />登录VBK</button>}
                          <button className="btn" data-variant="ghost" onClick={showVbkBrowser}>刷新状态</button>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
                {project.researchTasks.length > 0 && (
                  <div className="task-rail" data-empty={project.researchTasks.length === 0}>
                    <div className="task-rail-head">
                      <strong><ListChecks size={14} />待核查</strong>
                      <small>{project.researchTasks.length} 项 · {project.researchTasks.filter((t) => t.state === "confirmed" || t.state === "resolved").length} 已完成</small>
                    </div>
                    <div className="task-rail-body">
                      <div className="task-strip">
                        {project.researchTasks.map((task) => (
                          <button
                            key={task.id}
                            className="task-row-grid"
                            data-active={activeTask?.id === task.id}
                            data-done={task.state === "confirmed" || task.state === "resolved"}
                            onClick={() => setActiveTaskId(task.id)}
                            aria-label={`核查任务：${task.label}`}
                          >
                            <span className="marker">{task.state === "confirmed" || task.state === "resolved" ? <Check size={12} /> : <CircleHelp size={12} />}</span>
                            <span className="body">
                              <span className="label">{task.label}</span>
                              <span className="detail">{task.detail || "需要核查"}</span>
                            </span>
                            <span className="chip-mini" data-on={activeTask?.id === task.id}>{activeTask?.id === task.id ? "正在处理" : "待核查"}</span>
                          </button>
                        ))}
                      </div>
                      {activeTask && activeTask.state !== "confirmed" && activeTask.state !== "resolved" && (
                        <div className="task-detail-card">
                          <div className="body">
                            <div className="head"><span className="state" data-state="needsConfirmation">待核查</span></div>
                            <h4>{activeTask.label}</h4>
                            <p>{activeTask.detail || "请在 VBK 或公开来源完成核查，再填写结果。"}</p>
                            <textarea
                              className="task-result"
                              value={verificationNote}
                              onChange={(event) => setVerificationNote(event.target.value)}
                              placeholder="粘贴实际结果，例如资源组 ID、名称、价格或来源链接…"
                              aria-label="核查结果"
                            />
                            {isVehicleResourceTask(activeTask) && (
                              <button className="btn btn-sm vehicle-resolve-btn" type="button" data-variant="secondary" disabled={Boolean(resolvingVehicleTaskId)} onClick={() => void resolveVehicleTask()}>
                                {resolvingVehicleTaskId === activeTask.id ? <LoaderCircle size={14} /> : <CarFront size={14} />}
                                {isVbkLoggedIn ? "估算并匹配资源组" : "登录后自动匹配"}
                              </button>
                            )}
                          </div>
                          <div className="task-actions">
                            <button className="btn" data-variant="primary" disabled={loading || !verificationNote.trim()} onClick={() => void confirmTask()}>
                              {loading ? <LoaderCircle size={15} /> : <ClipboardCheck size={15} />}保存并写入
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </section>
            </div>
          )}
        </section>
      )}
    </main>
  </div>;
}

function ProductBriefForm({ input, setInput, submitting, onCancel, onSubmit }: { input: CreateProjectInput; setInput: (input: CreateProjectInput) => void; submitting: boolean; onCancel: () => void; onSubmit: () => void }) {
  return <div className="card brief-form">
    <div><h3>新建产品项目</h3><p className="view-sub">只需填写项目的三个基础信息；进入详情后再开始和 AI 沟通。</p></div>
    <div className="brief-grid">
      <label><span className="field-label">目的地</span><input className="input" autoFocus placeholder="例如：太原" value={input.destination} onChange={(event) => setInput({ ...input, destination: event.target.value })} /></label>
      <label><span className="field-label">产品形态</span><select className="input" value={input.productForm} onChange={(event) => setInput({ ...input, productForm: event.target.value as CreateProjectInput["productForm"] })}><option value="privateTour">私家团</option><option value="groupTour">跟团游</option></select></label>
      <label><span className="field-label">天数</span><input className="input" type="number" min="1" max="60" value={input.days} onChange={(event) => setInput({ ...input, days: Number(event.target.value) || 1 })} /></label>
    </div>
    <div className="form-actions"><button className="btn" data-variant="ghost" onClick={onCancel}>取消</button><button className="btn" data-variant="primary" disabled={submitting} onClick={onSubmit}>{submitting ? <LoaderCircle size={15} /> : <Plus size={15} />}创建并进入项目</button></div>
  </div>;
}
function WorkbenchModule({ icon, title, detail, state, action }: { icon: React.ReactNode; title: string; detail: string; state: "ready" | "todo"; action: React.ReactNode }) {
  return <section className="module-card" data-state={state}><span className="module-icon">{icon}</span><div><strong>{title}</strong><small>{detail}</small></div>{action}</section>;
}
function ProjectList({ projects, onOpen, onDelete }: { projects: ProjectSummary[]; onOpen: (item: ProjectSummary) => Promise<void>; onDelete: (item: ProjectSummary) => Promise<boolean> }) {
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const remove = async (item: ProjectSummary) => {
    if (deletingId) return;
    setDeletingId(item.id);
    const removed = await onDelete(item);
    setDeletingId(null);
    if (removed) setConfirmingId(null);
  };
  return <section className="project-list-shell" aria-label="产品项目列表"><div className="project-list-head"><div><strong>产品项目</strong><small>最近更新优先</small></div><span>{projects.length} 个</span></div><div className="project-list">{projects.map((item) => <div className="project-list-item" key={item.id}>
    <div className="project-row">
      <button className="project-row-open" type="button" onClick={() => void onOpen(item)} aria-label={`进入产品详情：${item.name}`}>
        <span className="project-row-icon"><PackageOpen size={16} /></span>
        <span className="project-main"><span className="project-title-line"><strong className="title">{item.name}</strong><span className="state" data-state={statusState(item.status)}>{statusLabel(item.status)}</span></span><span className="meta"><span>{item.productId ? `VBK ${item.productId}` : "本地产品草稿"}</span><span>更新 {formatUpdatedAt(item.updatedAt)}</span></span></span>
        <span className="project-enter" aria-hidden="true"><ChevronRight size={16} /></span>
      </button>
      <button className="project-delete-trigger" type="button" onClick={() => setConfirmingId((id) => id === item.id ? null : item.id)} disabled={item.status === "automating" || Boolean(deletingId)} aria-label={`删除项目：${item.name}`} title={item.status === "automating" ? "自动录入中，暂不能删除" : "删除项目"}><Trash2 size={15} /></button>
    </div>
    {confirmingId === item.id && <div className="project-delete-confirm" role="group" aria-label={`确认删除项目：${item.name}`}>
      <div><strong>删除「{item.name}」？</strong><small>将永久删除本机的产品方案、对话、核查任务和录入记录；不会删除 VBK 平台上的产品。</small></div>
      <div className="project-delete-actions"><button className="btn btn-sm" type="button" onClick={() => setConfirmingId(null)} disabled={deletingId === item.id}>取消</button><button className="btn btn-sm" data-variant="danger-solid" type="button" onClick={() => void remove(item)} disabled={deletingId === item.id}>{deletingId === item.id ? <LoaderCircle size={14} /> : <Trash2 size={14} />}确认删除</button></div>
    </div>}
  </div>)}</div></section>;
}
function EmptyProjectState({ onCreate }: { onCreate: () => void }) { return <div className="empty-state"><FileText size={28} /><h3>还没有产品项目</h3><p>从目的地、天数和产品形态开始，几分钟内得到可审查的通用方案。</p><button className="btn" data-variant="primary" onClick={onCreate}><Plus size={15} />创建第一个产品</button></div>; }
function Field({ label, value }: { label: string; value: string }) { return <div className="product-field"><span className="product-field-label">{label}</span><strong className="product-field-value" data-state={value === "待生成" ? "empty" : ""}>{value}</strong></div>; }
function formatIssueLabel(label: string) { return ({ "basicInfo.supplierProductCode": "产品编码", "basicInfo.subtitle": "产品副标题", "basicInfo.province": "所属省份", "basicInfo.operationNotes": "运营说明", sales: "产品类型", itinerary: "每日行程", commercial: "商业信息" } as Record<string, string>)[label] || label; }

// 把后端直发的技术校验文本映射为运营可直接执行的中文提示；保留有意义
// 的非技术描述（如 "建议补充图片"、"需与供应商二次确认"）。输入里出现
// "Invalid input"、"expected ... received"、"undefined"/"null" 等
// Zod/JSON 风格的内部错误信息时一律替换。
const issueGuidance: Record<string, string> = {
  "basicInfo.supplierProductCode": "请补充供应商产品编码",
  "basicInfo.subtitle": "请填写一句产品副标题",
  "basicInfo.operationNotes": "请补充运营录入说明"
};
const technicalDetailPattern = /(invalid input|expected .* received|undefined|null|required|received undefined|received null|invalid_type|invalid_string)/i;
function formatIssueGuidance(issue: { label: string; detail: string }) {
  const mapped = issueGuidance[issue.label];
  if (mapped) return { guidance: mapped, isTechnical: false };
  const detail = (issue.detail || "").trim();
  if (!detail || technicalDetailPattern.test(detail)) {
    return { guidance: "请在右侧核查后补齐该项内容", isTechnical: true };
  }
  return { guidance: detail, isTechnical: false };
}

function ShieldCheck(props: { size?: number; className?: string }) {
  const { size = 16, className } = props;
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      role="presentation"
      aria-hidden="true"
    >
      <path d="M12 3l8 3v5c0 4.5-3 8.4-8 9-5-.6-8-4.5-8-9V6l8-3z" />
      <path d="m9 12 2 2 4-4" />
    </svg>
  );
}
