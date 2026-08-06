import { useEffect, useLayoutEffect, useMemo } from "react";
import {
  activeAdvisorHint,
  initialStageFor,
  recoveryNeedsUser,
  statusState,
  vbkStageStatusText,
} from "../helpers";
import { api } from "../helpers";
import type { AppStateBase } from "./base";

export function useAppStateDerived(state: AppStateBase) {
  const {
    project,
    setProjects,
    setProject,
    setNotice,
    setActiveTaskId,
    setVerificationNote,
    setExpandedDayIndex,
    settings,
    setSettings,
    setStage,
    checkVbkLogin,
    refresh,
    updateReadiness,
    browserRef,
    conversationRef,
    vbkLogin,
    setBrowserOpen,
    setVbkLogin,
    setLoginPanelOpen,
    setCheckingVbkLogin,
    setAccountMenuOpen,
    browserOpen,
    view,
    loginPanelOpen,
    stage,
    setBrowserUrl,
  } = state as AppStateBase & { setNotice: (value: string | null) => void; setActiveTaskId: (id: string | null) => void; };

  const browserShouldMount = view === "workspace" && (stage === "vbk" || loginPanelOpen) && Boolean(project || loginPanelOpen);

  useEffect(() => {
    if (!api()) return;
    void refresh();
    void api()!.settings.get().then(setSettings).catch(() => setNotice("无法读取本机设置。"));
    void checkVbkLogin();
    const retryLoginCheck = window.setTimeout(() => void checkVbkLogin(), 1200);
    const unsubscribe = api()!.events.onProjectUpdated((next) => {
      setProject((current: typeof project) => current?.id === next.id ? next : current);
      void updateReadiness(next);
    });

    return () => {
      window.clearTimeout(retryLoginCheck);
      unsubscribe();
    };
  }, []);

  // VBK 登录成功后自动收起登录面板，避免右侧 VBK 浏览器残留在工作台首页。
  useEffect(() => {
    if (vbkLogin?.loggedIn && loginPanelOpen) {
      setLoginPanelOpen(false);
    }
  }, [vbkLogin?.loggedIn, loginPanelOpen]);

  useEffect(() => {
    void updateReadiness(project);
  }, [project?.id, project?.updatedAt]);

  useEffect(() => {
    setVerificationNote("");
  }, [state.activeTaskId]);

  // 切换项目时清空核查选择，避免上一个项目残留的 activeTaskId 落到新项目。
  useEffect(() => {
    if (!project) return;
    setActiveTaskId(null);
    setVerificationNote("");
    setStage(initialStageFor(project.status));
    setExpandedDayIndex(0);
  }, [project?.id]);

  // 项目进入兜底：进入仍为空草稿的项目时自动触发一次 AI 生成。
  useEffect(() => {
    if (!project || !api()) return;
    if (!settings?.hasMiniMaxKey) return;
    if (project.messages.some((message: { role: string }) => message.role === "user")) return;
    const itinerary = project.product.itinerary;
    if (Array.isArray(itinerary) && itinerary.length > 0) return;

    const content = [
      "请基于项目里已经写入的全部上下文（destination、days、nights、productForm、meetingCity/destinationCity、sales.productType、operations.hotelSource/酒店档位、basicInfo）直接生成完整第一版产品方案。",
      "需要写入的内容：产品卖点（presentation.subtitle / recommendation / features / recommendations 三条）、完整每日行程（itinerary，含 title/spots/activities/description/meals/hotel）、套餐/班期/条款的合理占位；并对需要核查的运营数据（城市ID、景点匹配、门票价格、用车资源、酒店资源）创建对应 researchTasks。",
      "请一次性返回完整 patch，不要再追问基础信息。",
    ].join("");
    console.info("[App] auto-ai fallback for empty project", { projectId: project.id });
    void api()!.ai.send(project.id, content);
  }, [project?.id, settings?.hasMiniMaxKey]);

  useEffect(() => {
    const conversation = conversationRef.current;
    if (conversation) conversation.scrollTop = conversation.scrollHeight;
  }, [project?.messages.length, state.loading]);

  // 第二步与登录窗口共享同一个 VBK 浏览器；只有它们需要把 BrowserView 切到可见并设置坐标。
  useLayoutEffect(() => {
    const target = browserRef.current;
    if (!target || !api() || !browserShouldMount) return;

    let frame = 0;
    const update = () => {
      const box = target.getBoundingClientRect();
      const width = Math.round(box.width);
      const height = Math.round(box.height);
      if (width <= 0 || height <= 0) return;
      // 主进程的 browser 在窗口加载完成后才创建，早期布局调用会被拒绝；这类失败静默忽略。
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

    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", scheduleUpdate);
      observer.disconnect();
    };
  }, [browserShouldMount, loginPanelOpen, stage, view, project?.id]);

  useEffect(() => {
    if (!api()) return;
    void api()!.browser.setVisible(Boolean(view === "workspace" && browserShouldMount)).catch(() => {});
  }, [view, browserShouldMount]);

  useEffect(() => {
    if (view === "workspace" && project && vbkLogin?.loggedIn && stage === "vbk" && !browserOpen) {
      setBrowserOpen(true);
    }
  }, [browserOpen, project, vbkLogin?.loggedIn, view, stage]);

  // URL 栏需要随嵌入式浏览器的实际地址同步。
  useEffect(() => {
    if (!api() || !browserShouldMount || view !== "workspace") return;
    let cancelled = false;
    const refreshUrl = async () => {
      if (cancelled) return;
      const next = await api()!.browser.currentUrl().catch(() => "");
      if (cancelled) return;
      if (next) setBrowserUrl((prev: string) => (prev === next ? prev : next));
    };
    void refreshUrl();
    const interval = window.setInterval(() => { void refreshUrl(); }, 1500);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [browserShouldMount, view]);

  const itinerary = useMemo(
    () => (project && Array.isArray(project.product.itinerary)
      ? project.product.itinerary as Array<Record<string, unknown>>
      : []),
    [project],
  );

  const basic = project ? (project.product.basicInfo || {}) as Record<string, unknown> : {};
  const presentation = project ? (project.product.presentation || {}) as Record<string, unknown> : {};

  const activeTask = state.activeTaskId
    ? project?.researchTasks.find((task: { id: string }) => task.id === state.activeTaskId)
    : undefined;

  const isVbkLoggedIn = Boolean(vbkLogin?.loggedIn);
  const loggedAccounts = isVbkLoggedIn ? (vbkLogin?.accounts?.length ? vbkLogin.accounts : [vbkLogin?.accountName || "已登录账号"]) : [];
  const currentAccountName = loggedAccounts[0] || "未登录";
  const accountInitial = currentAccountName === "未登录" ? "未" : currentAccountName.slice(0, 1).toUpperCase();

  const browserPlaceholderTitle = isVbkLoggedIn ? "VBK 已登录" : "在 VBK 中完成核查";
  const browserPlaceholderText = isVbkLoggedIn
    ? `${currentAccountName} 已登录，打开右侧页面继续核查当前待办。`
    : "登录后先核查当前待办；系统只会在你确认全部待办后保存产品草稿。";

  const splitStyle = project
    ? { gridTemplateColumns: stage === "review" ? "minmax(0, 1.27fr) minmax(0, 1fr)" : "minmax(0, 0.515fr) minmax(0, 1fr)" }
    : undefined;
  const projectCompletionLabel = state.readiness.ready ? "可以录入" : `${state.readiness.issues.length} 项待处理`;
  const vbkStageStatus = vbkStageStatusText(project);
  const automationActive = project?.automation?.status === "running";
  const recoveryBlocked = project?.automation ? recoveryNeedsUser(project.automation) : null;
  const advisorHint = project?.automation ? activeAdvisorHint(project.automation) : null;
  const automationPhases = project?.automation?.phases ?? [];
  const automationRecovery = project?.automation?.recovery?.phases;

  const saveDraftLabel = recoveryBlocked ? "重新开始一轮保存" : "保存草稿";
  const reviewStepStatus =
    !project
      ? "idle"
      : state.readiness.ready
        ? "passed"
        : state.readiness.issues.length
          ? "inProgress"
          : "reviewing";
  const vbkStepStatus =
    !project
      ? "idle"
      : vbkStageStatus.tone === "running"
        ? "inProgress"
        : vbkStageStatus.tone === "saved"
          ? "saved"
          : vbkStageStatus.tone === "blocked" || project.status === "blocked" || state.readiness.issues.length
            ? "blocked"
            : "waiting";

  return {
    itinerary,
    basic,
    presentation,
    activeTask,
    isVbkLoggedIn,
    loggedAccounts,
    currentAccountName,
    accountInitial,
    browserPlaceholderTitle,
    browserPlaceholderText,
    splitStyle,
    projectCompletionLabel,
    vbkStageStatus,
    automationActive,
    recoveryBlocked,
    advisorHint,
    automationPhases,
    automationRecovery,
    saveDraftLabel,
    reviewStepStatus,
    vbkStepStatus,
    statusState,
  };
}
