import { type CSSProperties, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Bot, BriefcaseBusiness, Check, ChevronLeft, ChevronRight, CircleCheck, CircleHelp, ClipboardCheck, ExternalLink, Eye, EyeOff, FileText, KeyRound, LoaderCircle, LogIn, PackageOpen, Play, Plus, RefreshCw, Send, Settings, Sparkles, TriangleAlert, UserRound } from "lucide-react";
import type { CreateProjectInput, MiniMaxConnectionTest, ProjectDetail, ProjectReadiness, ProjectSummary, Settings as AppSettings, VbkLoginStatus } from "../shared/contracts.js";

type Mode = "ai" | "balanced" | "vbk";
type View = "workspace" | "projects" | "settings";
type PaneKey = "ai" | "product" | "browser";
type PaneSizes = Record<PaneKey, number>;
type PaneDivider = "ai-product" | "product-browser";
const api = () => window.vbk;
const emptyReadiness: ProjectReadiness = { ready: false, completion: 0, issues: [] };
const initialInput: CreateProjectInput = { destination: "", days: 2, productForm: "privateTour" };
const dividerWidth = 6;
const paneMinimums: PaneSizes = { ai: 260, product: 280, browser: 360 };
const panePresetRatios: Record<Mode, PaneSizes> = {
  ai: { ai: 1.35, product: 1, browser: 0.9 },
  balanced: { ai: 1, product: 1, browser: 1 },
  vbk: { ai: 0.8, product: 0.8, browser: 1.6 }
};

function statusLabel(status?: string) { return ({ planning: "方案规划中", review: "等待确认", automating: "正在录入", draft_saved: "草稿已保存", blocked: "需要处理" } as Record<string, string>)[status || ""] || "准备开始"; }
function statusState(status?: ProjectSummary["status"]) { return ({ planning: "researching", review: "needsConfirmation", automating: "researching", draft_saved: "confirmed", blocked: "blocked" } as Record<ProjectSummary["status"], string>)[status || "planning"]; }
function paneWidth(target: HTMLElement | null) { return Math.max(0, Math.round((target?.getBoundingClientRect().width || 0) - dividerWidth * 2)); }
function paneSizesEqual(left: PaneSizes, right: PaneSizes) { return Math.abs(left.ai - right.ai) < 1 && Math.abs(left.product - right.product) < 1 && Math.abs(left.browser - right.browser) < 1; }
function normalizePaneSizes(sizes: PaneSizes, width: number): PaneSizes {
  const keys: PaneKey[] = ["ai", "product", "browser"];
  const minTotal = keys.reduce((sum, key) => sum + paneMinimums[key], 0);
  if (width <= minTotal) return { ...paneMinimums };
  const result = {} as PaneSizes;
  let available = width;
  let remaining = keys;
  while (remaining.length) {
    const weight = remaining.reduce((sum, key) => sum + Math.max(1, sizes[key]), 0);
    const constrained = remaining.filter((key) => available * Math.max(1, sizes[key]) / weight < paneMinimums[key]);
    if (!constrained.length) {
      remaining.forEach((key) => { result[key] = Math.round(available * Math.max(1, sizes[key]) / weight); });
      break;
    }
    constrained.forEach((key) => { result[key] = paneMinimums[key]; available -= paneMinimums[key]; });
    remaining = remaining.filter((key) => !constrained.includes(key));
  }
  return result;
}
function presetPaneSizes(mode: Mode, width: number) { return normalizePaneSizes(panePresetRatios[mode], width); }
function resizePanePair(start: PaneSizes, divider: PaneDivider, delta: number): PaneSizes {
  const next = { ...start };
  if (divider === "ai-product") {
    const total = start.ai + start.product;
    next.ai = Math.min(Math.max(start.ai + delta, paneMinimums.ai), total - paneMinimums.product);
    next.product = total - next.ai;
  } else {
    const total = start.product + start.browser;
    next.product = Math.min(Math.max(start.product + delta, paneMinimums.product), total - paneMinimums.browser);
    next.browser = total - next.product;
  }
  return next;
}
function formatUpdatedAt(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "时间未知";
  return date.toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}
function valueOf(source: Record<string, unknown>, key: string) { const value = source[key]; return typeof value === "string" || typeof value === "number" ? String(value) : "待生成"; }

export function App() {
  const [view, setView] = useState<View>("workspace");
  const [project, setProject] = useState<ProjectDetail | null>(null);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [readiness, setReadiness] = useState<ProjectReadiness>(emptyReadiness);
  const [mode, setMode] = useState<Mode>("ai");
  const [input, setInput] = useState("");
  const [paneSizes, setPaneSizes] = useState<PaneSizes | null>(null);
  const [customizedLayout, setCustomizedLayout] = useState(false);
  const [draggingDivider, setDraggingDivider] = useState<PaneDivider | null>(null);
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
  const [notice, setNotice] = useState<string | null>(null);
  const [miniMaxConfigOpen, setMiniMaxConfigOpen] = useState(false);
  const [miniMaxBaseUrl, setMiniMaxBaseUrl] = useState("https://api.minimaxi.com/v1");
  const [miniMaxApiKey, setMiniMaxApiKey] = useState("");
  const [showMiniMaxApiKey, setShowMiniMaxApiKey] = useState(false);
  const [savingMiniMax, setSavingMiniMax] = useState(false);
  const [testingMiniMax, setTestingMiniMax] = useState(false);
  const [miniMaxTest, setMiniMaxTest] = useState<MiniMaxConnectionTest | null>(null);
  const browserRef = useRef<HTMLDivElement>(null);
  const conversationRef = useRef<HTMLDivElement>(null);
  const splitRef = useRef<HTMLDivElement>(null);
  const resizeDragRef = useRef<{ divider: PaneDivider; startX: number; startSizes: PaneSizes } | null>(null);

  const checkVbkLogin = async (refresh = false) => {
    if (!api()) return;
    setCheckingVbkLogin(true);
    try { setVbkLogin(await api()!.browser.status(refresh)); }
    catch (error) { setVbkLogin({ loggedIn: false, message: error instanceof Error ? error.message : "无法检测 VBK 登录状态。" }); }
    finally { setCheckingVbkLogin(false); }
  };

  const refresh = async () => {
    if (!api()) return;
    const next = await api()!.projects.list();
    setProjects(next);
    setProject((current) => current && next.some((item) => item.id === current.id) ? current : null);
  };
  const updateReadiness = async (candidate: ProjectDetail | null) => {
    if (!candidate || !api()) return setReadiness(emptyReadiness);
    setReadiness(await api()!.projects.readiness(candidate.id));
  };
  useEffect(() => {
    if (!api()) return;
    void refresh();
    void api()!.settings.get().then(setSettings);
    void checkVbkLogin();
    const retryLoginCheck = window.setTimeout(() => void checkVbkLogin(), 1200);
    const unsubscribe = api()!.events.onProjectUpdated((next) => { setProject((current) => current?.id === next.id ? next : current); void updateReadiness(next); });
    return () => { window.clearTimeout(retryLoginCheck); unsubscribe(); };
  }, []);
  useEffect(() => { void updateReadiness(project); }, [project?.id, project?.updatedAt]);
  useEffect(() => { setVerificationNote(""); }, [activeTaskId]);
  useEffect(() => {
    const conversation = conversationRef.current;
    if (conversation) conversation.scrollTop = conversation.scrollHeight;
  }, [project?.messages.length, loading]);
  useLayoutEffect(() => {
    const target = browserRef.current; if (!target || !api()) return;
    let frame = 0;
    const update = () => {
      const box = target.getBoundingClientRect();
      const width = Math.round(box.width);
      const height = Math.round(box.height);
      if (width <= 0 || height <= 0) return;
      void api()!.browser.setBounds({ x: Math.round(box.x), y: Math.round(box.y), width, height });
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
  }, [browserOpen, loginPanelOpen, mode, paneSizes, view, project?.id]);
  useLayoutEffect(() => {
    const target = splitRef.current;
    if (!target || view !== "workspace" || !project) return;
    const syncPaneSizes = () => {
      const width = paneWidth(target);
      if (!width) return;
      setPaneSizes((current) => {
        const next = current ? normalizePaneSizes(current, width) : presetPaneSizes(mode, width);
        return current && paneSizesEqual(current, next) ? current : next;
      });
    };
    const observer = new ResizeObserver(syncPaneSizes);
    observer.observe(target);
    syncPaneSizes();
    return () => observer.disconnect();
  }, [mode, project?.id, view]);
  useEffect(() => {
    if (!draggingDivider) return;
    const onMove = (event: PointerEvent) => {
      const drag = resizeDragRef.current;
      if (!drag) return;
      setPaneSizes(resizePanePair(drag.startSizes, drag.divider, event.clientX - drag.startX));
    };
    const onEnd = () => {
      resizeDragRef.current = null;
      setDraggingDivider(null);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onEnd);
    window.addEventListener("blur", onEnd);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onEnd);
      window.removeEventListener("blur", onEnd);
    };
  }, [draggingDivider]);
  useEffect(() => { if (api()) void api()!.browser.setVisible(Boolean(browserOpen && view === "workspace" && (project || loginPanelOpen))); }, [browserOpen, view, project, loginPanelOpen]);
  useEffect(() => {
    if (view === "workspace" && project && vbkLogin?.loggedIn && !browserOpen) setBrowserOpen(true);
  }, [browserOpen, project, vbkLogin?.loggedIn, view]);

  const itinerary = useMemo(() => project && Array.isArray(project.product.itinerary) ? project.product.itinerary as Array<Record<string, unknown>> : [], [project]);
  const basic = project ? (project.product.basicInfo || {}) as Record<string, unknown> : {};
  const presentation = project ? (project.product.presentation || {}) as Record<string, unknown> : {};
  const activeTask = project?.researchTasks.find((task) => task.id === activeTaskId) || project?.researchTasks.find((task) => task.state !== "confirmed" && task.state !== "resolved");
  const isVbkLoggedIn = Boolean(vbkLogin?.loggedIn);
  const loggedAccounts = isVbkLoggedIn ? (vbkLogin?.accounts?.length ? vbkLogin.accounts : [vbkLogin?.accountName || "vbk_671205"]) : [];
  const currentAccountName = loggedAccounts[0] || "未登录";
  const accountInitial = currentAccountName === "未登录" ? "未" : currentAccountName.slice(0, 1).toUpperCase();
  const browserPlaceholderTitle = isVbkLoggedIn ? "VBK 已登录" : "在 VBK 中完成核查";
  const browserPlaceholderText = isVbkLoggedIn ? `${currentAccountName} 已登录，打开右侧页面继续核查当前待办。` : "登录后先核查当前待办；系统只会在你确认全部待办后保存产品草稿。";
  const splitStyle: CSSProperties | undefined = paneSizes ? {
    gridTemplateColumns: `${paneSizes.ai}px var(--divider) ${paneSizes.product}px var(--divider) ${paneSizes.browser}px`
  } : undefined;

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
  const startAutomation = async () => {
    if (!project || !readiness.ready) return;
    setNotice(null); setBrowserOpen(true); setLoading(true);
    try { await api()!.automation.start(project.id); }
    catch (error) { setNotice(error instanceof Error ? error.message : "自动录入失败，可在 VBK 中检查后重试。"); }
    finally { setLoading(false); }
  };
  const openMiniMaxConfig = async () => {
    setMiniMaxBaseUrl(settings?.minimaxBaseUrl || "https://api.minimaxi.com/v1");
    setMiniMaxApiKey(settings?.hasMiniMaxKey && api() ? await api()!.settings.getApiKey() : "");
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
    catch (error) { setMiniMaxTest({ connected: false, message: error instanceof Error ? error.message : "MiniMax 连接测试失败。" }); }
    finally { setTestingMiniMax(false); }
  };
  const openLogin = () => {
    setLoginPanelOpen(true); setView("workspace"); setProject(null); setBrowserOpen(true); setVbkLogin(null); setAccountMenuOpen(false);
    if (api()) void api()!.browser.login().then(() => void checkVbkLogin());
  };
  const showVbkBrowser = () => {
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
  const applyPreset = (nextMode: Mode) => {
    setMode(nextMode);
    setCustomizedLayout(false);
    const width = paneWidth(splitRef.current);
    if (width) setPaneSizes(presetPaneSizes(nextMode, width));
  };
  const beginPaneResize = (event: React.PointerEvent<HTMLDivElement>, divider: PaneDivider) => {
    if (event.button !== 0) return;
    const width = paneWidth(splitRef.current);
    const startSizes = paneSizes ? normalizePaneSizes(paneSizes, width) : presetPaneSizes(mode, width);
    resizeDragRef.current = { divider, startX: event.clientX, startSizes };
    setPaneSizes(startSizes);
    setCustomizedLayout(true);
    setDraggingDivider(divider);
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  };
  const resizeDividerFromKeyboard = (event: React.KeyboardEvent<HTMLDivElement>, divider: PaneDivider) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const width = paneWidth(splitRef.current);
    const startSizes = paneSizes ? normalizePaneSizes(paneSizes, width) : presetPaneSizes(mode, width);
    setPaneSizes(resizePanePair(startSizes, divider, event.key === "ArrowLeft" ? -32 : 32));
    setCustomizedLayout(true);
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
        <div className="preset-group" aria-label="布局预设">
          {(["ai", "balanced", "vbk"] as Mode[]).map((item) => (
            <button key={item} className="preset-btn" data-active={!customizedLayout && mode === item} onClick={() => applyPreset(item)}>
              {item === "ai" ? "AI优先" : item === "balanced" ? "均衡" : "VBK优先"}
            </button>
          ))}
        </div>
      )}
      {!project && (
        <div className="topbar-status">
          <span className="dot" data-state={vbkLogin?.loggedIn ? "ok" : "warn"} />
          {currentAccountName}
        </div>
      )}
    </header>
      {notice && <div className="notice" role="status"><TriangleAlert size={15} /><span>{notice}</span><button onClick={() => setNotice(null)}>关闭</button></div>}
      {view === "settings" && !project && <section className="view"><div className="view-container narrow"><div><h1 className="view-h1">设置</h1><p className="view-sub">连接配置和 VBK 登录状态都在这里管理。</p></div><div className="settings-stack"><section className="settings-block"><div className="settings-block-head"><KeyRound size={17} /><div><strong>连接设置</strong><small>MiniMax 用于生成产品方案和后续调整。</small></div></div><div className="settings-row"><div><strong className="settings-row-label">MiniMax</strong><p className="settings-row-desc">{settings?.hasMiniMaxKey ? `已连接 ${settings.minimaxBaseUrl}` : "尚未配置 API Key。"}</p></div><div className="settings-actions">{settings?.hasMiniMaxKey && <button className="icon-btn" type="button" onClick={() => void testSavedMiniMaxConnection()} disabled={testingMiniMax} aria-label="重新测试 MiniMax 连接" title="重新测试连接">{testingMiniMax ? <LoaderCircle size={16} /> : <Check size={16} />}</button>}<button className="btn" data-variant="ai" onClick={() => miniMaxConfigOpen ? setMiniMaxConfigOpen(false) : void openMiniMaxConfig()}>{miniMaxConfigOpen ? "收起配置" : settings?.hasMiniMaxKey ? "更新配置" : "配置连接"}</button></div></div>{miniMaxTest && !miniMaxConfigOpen && <p className="field-hint" data-state={miniMaxTest.connected ? "confirmed" : "blocked"}>{miniMaxTest.message}</p>}{miniMaxConfigOpen && <form className="minimax-config-form" onSubmit={(event) => { event.preventDefault(); void saveMiniMaxConfig(); }}><label><span className="field-label">服务地址</span><input className="input mono" type="url" inputMode="url" autoComplete="url" placeholder="https://api.minimaxi.com/v1" value={miniMaxBaseUrl} onChange={(event) => { setMiniMaxBaseUrl(event.target.value); setMiniMaxTest(null); }} /></label><label><span className="field-label">API Key</span><span className="secret-input"><input className="input" type={showMiniMaxApiKey ? "text" : "password"} autoComplete="off" placeholder={settings?.hasMiniMaxKey ? "已保存；留空则使用已保存的 Key" : "请输入 MiniMax API Key"} value={miniMaxApiKey} onChange={(event) => { setMiniMaxApiKey(event.target.value); setMiniMaxTest(null); }} /><button className="secret-toggle" type="button" onClick={() => setShowMiniMaxApiKey((visible) => !visible)} aria-label={showMiniMaxApiKey ? "隐藏 API Key" : "显示 API Key"} aria-pressed={showMiniMaxApiKey}>{showMiniMaxApiKey ? <Eye size={16} /> : <EyeOff size={16} />}</button></span><small className="field-hint">已保存的 Key 会回填到此处，默认保持隐藏；测试不会保存新输入的 Key。</small></label>{miniMaxTest && <p className="field-hint" data-state={miniMaxTest.connected ? "confirmed" : "blocked"}>{miniMaxTest.message}</p>}<div className="form-actions"><button className="btn" type="button" data-variant="ghost" onClick={() => { setMiniMaxConfigOpen(false); setMiniMaxApiKey(""); setShowMiniMaxApiKey(false); setMiniMaxTest(null); }}>取消</button><button className="btn" type="button" onClick={() => void testMiniMaxConnection()} disabled={testingMiniMax}>{testingMiniMax ? <LoaderCircle size={15} /> : null}测试连接</button><button className="btn" type="submit" data-variant="ai" disabled={savingMiniMax}>{savingMiniMax ? <LoaderCircle size={15} /> : null}保存配置</button></div></form>}</section><section className="settings-block"><div className="settings-block-head"><UserRound size={17} /><div><strong>VBK 登录设置</strong><small>已登录账号会显示在列表里，登录态只保存在本机。</small></div></div><div className="account-list">{loggedAccounts.length ? loggedAccounts.map((name) => <div className="account-row" key={name}><span className="account-avatar">{name.slice(0, 1).toUpperCase()}</span><span><strong>{name}</strong><small>已登录 VBK</small></span><div className="account-actions"><span className="state" data-state="current">当前</span><button className="btn btn-sm" data-variant="ghost" onClick={() => void logoutVbk()} disabled={checkingVbkLogin}>登出</button></div></div>) : <div className="account-row" data-empty="true"><span className="account-avatar">未</span><span><strong>暂无已登录账号</strong><small>{checkingVbkLogin ? "正在检查登录状态" : "新增登录后会出现在这里"}</small></span></div>}</div><div className="settings-foot"><button className="icon-btn" type="button" onClick={() => void checkVbkLogin(true)} disabled={checkingVbkLogin} aria-label="刷新 VBK 登录状态" title="刷新登录状态">{checkingVbkLogin ? <LoaderCircle size={16} /> : <RefreshCw size={16} />}</button><button className="btn" onClick={openLogin}><LogIn size={15} />新增登录VBK</button></div></section></div></div></section>}
      {view === "projects" && !project && <section className="view projects-view"><div className="view-container content-width project-view-container"><div className="project-page-head"><div><h1 className="view-h1">项目</h1><p className="view-sub">管理产品草稿、规划进度和录入状态。</p></div><button className="btn" data-variant="primary" onClick={startCreateProduct}><Plus size={16} />新建产品</button></div>{creating && <ProductBriefForm input={createInput} setInput={setCreateInput} submitting={savingProject} onCancel={() => setCreating(false)} onSubmit={() => void createProject()} />}{projects.length ? <ProjectList projects={projects} onOpen={async (item) => { const next = await api()!.projects.get(item.id); setProject(next); setView("workspace"); }} /> : !creating && <EmptyProjectState onCreate={startCreateProduct} />}</div></section>}
      {view === "workspace" && !project && <section className="view login-stage" data-login-open={loginPanelOpen}>
        <div className="view-container content-width workspace-home">
          <div className="home-head"><div><h1 className="view-h1">工作台</h1><p className="view-sub">只保留日常操作必须入口：AI 连接、VBK 登录和产品项目。</p></div><button className="btn" data-variant="primary" onClick={startCreateProduct}><Plus size={16} />新建产品</button></div>
          <div className="module-grid"><WorkbenchModule icon={<Sparkles size={18} />} title="MiniMax" detail={settings?.hasMiniMaxKey ? "连接已配置，可生成方案" : "未配置 API Key"} state={settings?.hasMiniMaxKey ? "ready" : "todo"} action={settings?.hasMiniMaxKey ? <button className="btn btn-sm" onClick={() => void testSavedMiniMaxConnection()}>{testingMiniMax ? <LoaderCircle size={14} /> : <Check size={14} />}测试</button> : <button className="btn btn-sm" data-variant="ai" onClick={() => { setView("settings"); void openMiniMaxConfig(); }}>配置</button>} /><WorkbenchModule icon={<LogIn size={18} />} title="VBK" detail={vbkLogin?.loggedIn ? `${currentAccountName} 已登录` : checkingVbkLogin ? "正在检测登录状态" : "需要登录后核查和保存草稿"} state={vbkLogin?.loggedIn ? "ready" : "todo"} action={vbkLogin?.loggedIn ? <button className="btn btn-sm" onClick={() => void checkVbkLogin(true)}><RefreshCw size={14} />刷新</button> : <button className="btn btn-sm" onClick={openLogin}><LogIn size={14} />登录</button>} /><WorkbenchModule icon={<PackageOpen size={18} />} title="产品" detail={`${projects.length} 个产品项目`} state={projects.length ? "ready" : "todo"} action={<button className="btn btn-sm" onClick={openProductList}>进入列表</button>} /></div>
          <section className="quick-panel"><div><strong>产品快捷入口</strong><small>新建产品后会直接进入产品详情；详情面包屑可返回项目列表。</small></div><div className="quick-actions"><button className="btn" data-variant="primary" onClick={startCreateProduct}><Plus size={15} />新建产品</button><button className="btn" onClick={openProductList}><FileText size={15} />产品列表</button>{projects[0] && <button className="btn" data-variant="ghost" onClick={async () => { const next = await api()!.projects.get(projects[0].id); setProject(next); setView("workspace"); }}>进入最近产品</button>}</div></section>
        </div>
        {loginPanelOpen && <section className="login-browser" aria-label="VBK 登录窗口"><div className="browser-chrome"><div className="browser-url"><span className="host">vbooking.ctrip.com</span><span className="path">/登录</span></div><button className="icon-btn" type="button" onClick={() => void checkVbkLogin(true)} disabled={checkingVbkLogin} aria-label="刷新 VBK 登录状态" title="刷新登录状态">{checkingVbkLogin ? <LoaderCircle size={16} /> : <RefreshCw size={16} />}</button><button className="icon-btn" type="button" onClick={() => { setLoginPanelOpen(false); setBrowserOpen(false); }} aria-label="关闭登录窗口" title="关闭">×</button></div><div className="browser-viewport" ref={browserRef} /></section>}
      </section>}
      {view === "workspace" && project && <section className="split" data-mode={mode} data-custom={customizedLayout} data-resizing={Boolean(draggingDivider)} ref={splitRef} style={splitStyle}>
        <section className="panel ai"><div className="panel-header"><div><strong className="panel-title">方案协作</strong><span className="panel-sub">项目上下文已带入，可随时继续追问或调整</span></div></div><div className="conversation" ref={conversationRef} role="log" aria-live="polite">{project.messages.map((message, index) => {
          const retryContent = message.role === "assistant" && message.taskStatus === "failed" ? project.messages.slice(0, index).reverse().find((item) => item.role === "user")?.content : undefined;
          return <article className="msg" data-role={message.role} data-state={message.taskStatus} key={message.id}><span className="msg-avatar">{message.role === "assistant" ? <Bot size={14} /> : message.role === "system" ? <TriangleAlert size={14} /> : "我"}</span><div className="msg-body"><div className="msg-content"><p>{message.content}</p></div><small className="msg-meta">{new Date(message.createdAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}{message.role === "user" && message.taskStatus === "running" && <><span>·</span><span className="msg-progress"><LoaderCircle size={12} />正在等待 AI 回复</span></>}{message.taskStatus === "failed" && <><span>·</span><span className="msg-error">本轮未完成</span></>}</small>{retryContent && <button className="msg-retry" type="button" onClick={() => void send(retryContent)} disabled={loading}><RefreshCw size={13} />重新发送这条消息</button>}</div></article>;
        })}{loading && <div className="ai-thinking" role="status"><Bot size={14} /><span>AI 正在生成回复…</span></div>}</div><div className="composer"><div className="composer-input"><textarea className="textarea" placeholder="例如：为这个产品生成通用行程；或：面向亲子客群设计一版方案…" value={input} onChange={(event) => setInput(event.target.value)} onKeyDown={(event) => { if ((event.metaKey || event.ctrlKey) && event.key === "Enter") void send(); }} disabled={loading} /><button className="composer-send" type="button" aria-label="发送消息，Command 加回车可快速发送" aria-describedby="composer-send-tip" aria-disabled={loading || !input.trim()} data-disabled={loading || !input.trim()} onClick={() => void send()} disabled={loading}>{loading ? <LoaderCircle size={16} /> : <Send size={16} />}<span className="composer-tooltip" id="composer-send-tip" role="tooltip"><strong>发送消息</strong><span><kbd>Command</kbd><kbd>Enter</kbd> 快速发送</span></span></button></div><div className="composer-row"><span className="composer-hint">AI 已知目的地、产品形态和天数；资源、价格与库存必须经 VBK 核查。</span></div></div></section>
        <div className="divider" data-dragging={draggingDivider === "ai-product"} role="separator" aria-orientation="vertical" tabIndex={0} aria-label="调整方案协作和产品审查宽度" title="拖拽调整方案协作和产品审查宽度" onPointerDown={(event) => beginPaneResize(event, "ai-product")} onKeyDown={(event) => resizeDividerFromKeyboard(event, "ai-product")} />
        <section className="panel product"><div className="panel-header"><div><strong className="panel-title">产品审查</strong><span className="panel-sub">{readiness.completion}% 就绪</span></div><span className="state" data-state={readiness.ready ? "confirmed" : "needsConfirmation"}>{readiness.ready ? "可以录入" : `${readiness.issues.length} 项待处理`}</span></div><div className="product-scroll"><section className="review-callout" data-ready={readiness.ready}>{readiness.ready ? <CircleCheck size={17} /> : <CircleHelp size={17} />}<div><strong>{readiness.ready ? "方案已满足录入条件" : "下一步：完成待核查项目"}</strong><p>{readiness.ready ? "确认后将自动填写 VBK 并保存为草稿，不会提审或发布。" : "第一版方案已经生成；请先补齐下方的录入前检查，再确认待办。"}</p></div></section>{!readiness.ready && <section className="readiness-issues"><strong>录入前检查</strong>{readiness.issues.map((issue, index) => <div className="readiness-issue" key={`${issue.label}-${index}`}><TriangleAlert size={13} /><span><b>{formatIssueLabel(issue.label)}</b>{issue.detail}</span></div>)}</section>}<section className="product-section"><div className="product-section-head"><strong className="product-section-title">基础信息</strong></div><div className="product-grid"><Field label="产品名称" value={valueOf(basic, "supplierProductName")} /><Field label="集合城市" value={valueOf(basic, "meetingCity")} /><Field label="目的城市" value={valueOf(basic, "destinationCity")} /><Field label="行程规格" value={`${valueOf(basic, "days")} 天 ${valueOf(basic, "nights")} 晚`} /></div></section><section className="product-section"><div className="product-section-head"><strong className="product-section-title">每日行程</strong><span className="product-section-meta">{itinerary.length} 天</span></div>{itinerary.length ? <div className="product-itinerary">{itinerary.map((day, index) => <div className="product-itinerary-day" key={index}><span className="product-day-index">D{index + 1}</span><div><strong className="product-day-title">{valueOf(day, "title")}</strong><div className="product-day-spots">{Array.isArray(day.spots) ? day.spots.map((spot) => <span className="chip" key={String(spot)}>{String(spot)}</span>) : <span className="chip">待补充景点</span>}</div></div></div>)}</div> : <p className="section-empty">正在等待 AI 生成第一版行程。</p>}</section><section className="product-section"><div className="product-section-head"><strong className="product-section-title">产品卖点</strong></div><div className="review-copy"><strong>{valueOf(presentation, "recommendation")}</strong><p>{valueOf(presentation, "features")}</p></div></section><section className="product-section"><div className="product-section-head"><strong className="product-section-title">待办与核查</strong><span className="product-section-meta">{project.researchTasks.length} 项</span></div>{project.researchTasks.length ? <div className="task-list">{project.researchTasks.map((task) => <button key={task.id} className="task-row" data-active={activeTask?.id === task.id} data-done={task.state === "confirmed" || task.state === "resolved"} onClick={() => setActiveTaskId(task.id)}><span>{task.state === "confirmed" || task.state === "resolved" ? <Check size={14} /> : <CircleHelp size={14} />}</span><span><strong>{task.label}</strong><small>{task.detail || "需要核查"}</small></span></button>)}</div> : <p className="section-empty">AI 会把不能凭空确定的运营数据列到这里。</p>}</section></div><footer className="product-footer"><span className="product-footer-meta">{readiness.ready ? "已通过产品完整性与核查任务检查" : "完成全部待办后，才可以保存 VBK 草稿"}</span><button className="btn" data-variant="primary" disabled={!readiness.ready || loading} onClick={() => void startAutomation()}><Play size={15} />确认并保存草稿</button></footer></section>
        <div className="divider" data-dragging={draggingDivider === "product-browser"} role="separator" aria-orientation="vertical" tabIndex={0} aria-label="调整产品审查和 VBK 浏览器宽度" title="拖拽调整产品审查和 VBK 浏览器宽度" onPointerDown={(event) => beginPaneResize(event, "product-browser")} onKeyDown={(event) => resizeDividerFromKeyboard(event, "product-browser")} />
        <section className="panel browser"><div className="browser-chrome"><button className="icon-btn" aria-label="返回"><ChevronLeft size={16} /></button><div className="browser-url"><span className="host">vbooking.ctrip.com</span><span className="path">/产品库</span></div><button className="icon-btn" aria-label="刷新" onClick={showVbkBrowser}><RefreshCw size={16} /></button><button className="icon-btn" aria-label="打开外部浏览器"><ExternalLink size={16} /></button></div><div className="browser-viewport" ref={browserRef}>{!browserOpen && <div className="browser-placeholder"><div className="browser-placeholder-card">{isVbkLoggedIn ? <Check size={22} /> : <LogIn size={22} />}<h4>{browserPlaceholderTitle}</h4><p>{browserPlaceholderText}</p><div className="btn-row">{isVbkLoggedIn ? <button className="btn" data-variant="primary" onClick={showVbkBrowser}><RefreshCw size={15} />显示浏览器</button> : <button className="btn" data-variant="primary" onClick={openLogin}><LogIn size={15} />登录VBK</button>}<button className="btn" data-variant="ghost" onClick={showVbkBrowser}>刷新状态</button></div></div></div>}</div>{activeTask && activeTask.state !== "confirmed" && activeTask.state !== "resolved" && <aside className="task-detail"><div><span className="state" data-state="needsConfirmation">待核查</span><h3>{activeTask.label}</h3><p>{activeTask.detail || "请在 VBK 或公开来源完成核查，再填写结果。"}</p><textarea className="task-result" value={verificationNote} onChange={(event) => setVerificationNote(event.target.value)} placeholder="粘贴实际结果，例如资源组 ID、名称、价格或来源链接…" /></div><button className="btn" data-variant="primary" disabled={loading || !verificationNote.trim()} onClick={() => void confirmTask()}>{loading ? <LoaderCircle size={15} /> : <ClipboardCheck size={15} />}保存并写入方案</button></aside>}{project.automation && <aside className="automation"><div className="automation-head"><Sparkles size={16} /><strong className="automation-title">自动录入</strong><span className="state" data-state={project.automation.status === "failed" ? "blocked" : project.automation.status === "succeeded" ? "confirmed" : "researching"}>{project.automation.status === "succeeded" ? "草稿已保存" : "执行中"}</span></div><div className="automation-body">{project.automation.phases.map((phase) => <div className="stage" data-state={phase.status === "completed" ? "done" : phase.status === "running" ? "running" : phase.status === "failed" ? "failed" : "pending"} key={phase.phase}><span className="stage-dot" />{phase.phase}</div>)}<p className="automation-note">系统只保存草稿，不会提交审核或发布。</p></div></aside>}</section>
      </section>}
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
function ProjectList({ projects, onOpen }: { projects: ProjectSummary[]; onOpen: (item: ProjectSummary) => Promise<void> }) {
  return <section className="project-list-shell" aria-label="产品项目列表"><div className="project-list-head"><div><strong>产品项目</strong><small>最近更新优先</small></div><span>{projects.length} 个</span></div><div className="project-list">{projects.map((item) => <button className="project-row" key={item.id} onClick={() => void onOpen(item)} aria-label={`进入产品详情：${item.name}`}><span className="project-row-icon"><PackageOpen size={16} /></span><span className="project-main"><span className="project-title-line"><strong className="title">{item.name}</strong><span className="state" data-state={statusState(item.status)}>{statusLabel(item.status)}</span></span><span className="meta"><span>{item.productId ? `VBK ${item.productId}` : "本地产品草稿"}</span><span>更新 {formatUpdatedAt(item.updatedAt)}</span></span></span><span className="project-enter" aria-hidden="true"><ChevronRight size={16} /></span></button>)}</div></section>;
}
function EmptyProjectState({ onCreate }: { onCreate: () => void }) { return <div className="empty-state"><FileText size={28} /><h3>还没有产品项目</h3><p>从目的地、天数和产品形态开始，几分钟内得到可审查的通用方案。</p><button className="btn" data-variant="primary" onClick={onCreate}><Plus size={15} />创建第一个产品</button></div>; }
function ReadinessRow({ complete, title, detail, action }: { complete: boolean; title: string; detail: string; action?: React.ReactNode }) { return <div className="readiness-row"><span className="readiness-icon" data-done={complete}>{complete ? <Check size={15} /> : <CircleHelp size={15} />}</span><span><strong>{title}</strong><small>{detail}</small></span>{action}</div>; }
function Field({ label, value }: { label: string; value: string }) { return <div className="product-field"><span className="product-field-label">{label}</span><strong className="product-field-value" data-state={value === "待生成" ? "empty" : ""}>{value}</strong></div>; }
function formatIssueLabel(label: string) { return ({ "basicInfo.supplierProductCode": "产品编码", "basicInfo.subtitle": "产品副标题", "basicInfo.province": "所属省份", "basicInfo.operationNotes": "运营说明", sales: "产品类型", itinerary: "每日行程", commercial: "商业信息" } as Record<string, string>)[label] || label; }
