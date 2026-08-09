import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  activeAdvisorHint,
  buildPlanningStageProgress,
  initialStageFor,
  planningStageLabel,
  recoveryNeedsUser,
  statusState,
  vbkStageStatusText,
} from "../helpers";
import { PLANNING_STAGES } from "../../../shared/contracts-planning.js";
import { api } from "../helpers";
import { hasActiveAiKey } from "../../../shared/ai-provider-config.js";
import type { AppStateBase } from "./base";
import type { PlanningGenerationState } from "../../../shared/contracts-planning.js";
import { shouldAutoStartPlanning } from "./auto-start-policy.js";
import { simulateRecoveryEffectTick } from "./recovery-policy.js";
import { upsertProjectToTop } from "./project-list-helper.js";

export function useAppStateDerived(state: AppStateBase) {
  const {
    project,
    setProjects,
    setProject,
    activeProjectId,
    setActiveProjectId,
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

  // 规划状态：本地缓存 + UI 触发器。auto-start 必须看到 failed/needs_user 不再自动重跑；
  // 用户通过 planning.resume 手动续跑，避免并发触发。
  const [planningState, setPlanningState] = useState<PlanningGenerationState | null>(null);
  const [autoStartUsed, setAutoStartUsed] = useState<string | null>(null);
  // 续跑按钮点击锁：点击后到 planning.state 携新状态返回前，避免重复点击造成双触发。
  const [planningBusy, setPlanningBusy] = useState(false);
  // Per-project sentinel：标记「planning.state(projectId) 已对当前 project 完成」。
  // 未完成时 auto-start effect 必须空跑：这样能避免「persisted failed 项目被重新打开」
  // 时 effect 在 lookup 回来前抢跑 planning.start，把已经失败的项目又拉起一次。
  // 切换项目时复位为 null（由下面的 project-switch effect 负责）。
  const [planningStateLoadedProjectId, setPlanningStateLoadedProjectId] = useState<string | null>(null);
  // 用于 planning.state() 异步回调内做项目 id 比对，避免切换项目后旧响应污染当前项目。
  const currentProjectIdRefForPlanning = useRef<string | null>(null);
  // 首次 planning.state 补偿是异步的：若它返回前已收到 planning:updated，旧查询
  // 结果不得反向覆盖实时状态。每个已接受的当前项目事件都递增该版本号。
  const planningEventVersionRef = useRef(0);
  // 此 ref 同时供首次补偿与实时事件使用；项目切换后迟到的状态事件不能污染新项目。
  currentProjectIdRefForPlanning.current = project?.id ?? null;

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
      setProjects((prev) => upsertProjectToTop(prev, next));
    });
    const unsubscribePlanning = api()!.events.onPlanningStateUpdated((projectId, next) => {
      if (currentProjectIdRefForPlanning.current !== projectId) return;
      planningEventVersionRef.current += 1;
      setPlanningState(next);
      setPlanningStateLoadedProjectId(projectId);
    });

    return () => {
      window.clearTimeout(retryLoginCheck);
      unsubscribe();
      unsubscribePlanning();
    };
  }, []);

  // VBK 登录成功后自动收起登录面板，避免右侧 VBK 浏览器残留在工作台首页。
  useEffect(() => {
    if (vbkLogin?.loggedIn && loginPanelOpen) {
      setLoginPanelOpen(false);
    }
  }, [vbkLogin?.loggedIn, loginPanelOpen]);

  // 启动 / 刷新时恢复最近打开的项目：只持久化 id 不足以让 React 看到
  // ProjectDetail，必须再向主进程拉一次权威数据。
  //
  // 关键不变量（详见 ./recovery-policy.ts 的纯函数决策）：
  //   - 只在 view === "workspace" 时恢复。切到 projects / settings / operation-log 后
  //     用户明确离开详情，effect 必须短路，不再发起请求或回填 project；
  //   - 同一会话内只尝试一次（hasAttempted gate）：点"工作台"按钮
  //     （setProject(null) + setView("workspace")）后 view 仍是 workspace，如果
  //     只看 view 会再次触发，把刚被用户清掉的项目又塞回来。点击"项目"/"设置"/
  //     "操作日志"时则由 view gate 拦截；
  //   - 用户在初始化期间手动 openProject(A) 时同样消费本会话恢复机会——
  //     主动接管项目选择之后，session 内不应再自动恢复，否则清掉 project
  //     回 workspace 又被拉回详情（核心防回填，详见 simulateRecoveryEffectTick）；
  //   - 项目不存在 / 主进程报错 → 清掉残留 id + activeProjectId，让下次启动不再
  //     尝试恢复；但 view 已切走时不清理（用户可能想用 localStorage 里的 id
  //     重新打开）；
  //   - 异步取消：cleanup 把 cancelled 置 true，.then() / .catch() 跳过；用
  //     currentViewForRecoveryRef + currentActiveProjectIdForRecoveryRef 在
  //     in-flight 期间 view / activeProjectId 切换时再次确认（refs 在每次 render
  //     同步更新，闭包读到的总是最新值），避免旧请求覆盖目标项目。
  const recoveryAttemptedRef = useRef(false);
  const currentViewForRecoveryRef = useRef<typeof view>(view);
  const currentActiveProjectIdForRecoveryRef = useRef<string | null>(activeProjectId);
  currentViewForRecoveryRef.current = view;
  currentActiveProjectIdForRecoveryRef.current = activeProjectId;

  useEffect(() => {
    const decision = simulateRecoveryEffectTick({
      hasApi: Boolean(api()),
      view,
      hasProject: Boolean(project),
      hasActiveProjectId: Boolean(activeProjectId),
      hasAttempted: recoveryAttemptedRef.current,
    });
    recoveryAttemptedRef.current = decision.nextHasAttempted;
    if (!decision.shouldRequest) return;
    const targetId = activeProjectId as string;
    let cancelled = false;
    void api()!.projects.get(targetId).then((detail) => {
      if (cancelled) return;
      // 即便 cancelled 标志位为 false，也再校验一次当前 view + activeProjectId：
      // 用户可能在 in-flight 期间主动退出详情页（setProject(null) → sync effect
      // 把 activeProjectId 清掉）或切到非 workspace 视图，此时不能把已拉到手的
      // 旧项目再塞回去。
      if (currentViewForRecoveryRef.current !== "workspace") return;
      if (currentActiveProjectIdForRecoveryRef.current !== targetId) return;
      setProject(detail);
    }).catch(() => {
      if (cancelled) return;
      // view 已切走时不清理 localStorage / activeProjectId：用户可能还在用
      // projects 视图，需要保留 id 以便重新打开。
      if (currentViewForRecoveryRef.current !== "workspace") return;
      if (currentActiveProjectIdForRecoveryRef.current !== targetId) return;
      // 项目已被删除或主进程暂时不可达：清掉 localStorage，让 UI 回落到
      // 工作台首页（AppWorkspaceHomePage），下次启动不再尝试恢复。
      try { localStorage.removeItem("vbk:activeProjectId"); } catch { /* 忽略 */ }
      setActiveProjectId(null);
    });
    return () => { cancelled = true; };
    // activeProjectId / project?.id / view 都进 deps：用户在拉取期间切走时 effect
    // 会 cleanup + 重新跑，重新跑时会被 policy 的几条短路拦住（project 已存在 /
    // activeProjectId 已清 / view 非 workspace / 已 attempt 过），不再发起多余请求。
  }, [activeProjectId, project?.id, view]);

  useEffect(() => {
    void updateReadiness(project);
  }, [project?.id, project?.updatedAt]);

  useEffect(() => {
    setVerificationNote("");
  }, [state.activeTaskId]);

  // 切换项目时清空核查选择，避免上一个项目残留的 activeTaskId 落到新项目。
  // 同时复位 planning 相关本地缓存，保证 sentinel / autoStartUsed 不会跨项目残留；
  // planning.state 由下一个 effect 异步拉取，sentinel 复位为 null 让 auto-start 等它回来。
  useEffect(() => {
    if (!project) return;
    setActiveTaskId(null);
    setVerificationNote("");
    setStage(initialStageFor(project.status));
    setExpandedDayIndex(0);
    setPlanningState(null);
    setAutoStartUsed(null);
    setPlanningStateLoadedProjectId(null);
  }, [project?.id]);

  // 项目进入兜底：进入仍为空草稿的项目时自动触发一次 staged planning 生成。
  // 规划走 planner.start，由后端分阶段 + bounded retry；ai:send 仍保留供后续多轮对话。
  // 关键不变量：必须等到 planning.state(projectId) 已对当前 projectId 完成（sentinel
  // 命中）；在此之前空跑。否则 persisted failed 的项目被重新打开时，会在 lookup 还没
  // 回来前抢跑一次 planning.start，把失败的项目又拉起一次。决策逻辑抽出到
  // shouldAutoStartPlanning，便于纯函数单测。
  useEffect(() => {
    if (!project || !api()) return;
    if (!shouldAutoStartPlanning({
      hasProject: true,
      projectId: project.id,
      hasUserMessages: project.messages.some((message: { role: string }) => message.role === "user"),
      hasItinerary: Array.isArray(project.product.itinerary) && (project.product.itinerary as unknown[]).length > 0,
      hasAiKey: hasActiveAiKey(settings),
      planningStateLoadedProjectId,
      planningState,
      autoStartUsed,
    })) return;
    setAutoStartUsed(project.id);
    console.info("[App] auto-planning fallback for empty project", { projectId: project.id, provider: settings?.aiProvider });
    const capturedProjectId = project.id;
    let cancelled = false;
    // planning.start IPC 会同步等待整轮 AI；先放入本地 pending，让 UI 立刻显示
    // 0/7；后续持久化状态会由 planning:updated 事件直接推送。
    setPlanningState({
      projectId: capturedProjectId,
      currentStage: "skeleton",
      completedStages: [],
      stages: [],
      status: "pending",
      resumeAt: new Date().toISOString(),
    });
    void api()!.planning.start(capturedProjectId).then((result) => {
      if (cancelled || currentProjectIdRefForPlanning.current !== capturedProjectId) return;
      if (result.state) setPlanningState(result.state);
      if (result.status === "failed") {
        // preflight 失败（例如 safeStorage 不可用）→ IPC 也会返回 normal PlanningRunResult；
        // 这里显式 setNotice，让 recovery strip 的「重试规划」按钮有上下文；
        // assistantReply 已是 provider-neutral 中文，不会泄露密钥 / 密文。
        setNotice(result.assistantReply || "方案规划未能启动，请检查 API Key 后重试。");
      }
    }).catch((error) => {
      if (cancelled || currentProjectIdRefForPlanning.current !== capturedProjectId) return;
      console.warn("[App] planning.start failed", error);
      setNotice(`方案规划异常：${(error as { message?: string })?.message ?? String(error)}`);
    });
    return () => {
      cancelled = true;
    };
  }, [project?.id, settings?.aiProvider, settings?.hasMiniMaxKey, settings?.hasDeepSeekKey, planningState, planningStateLoadedProjectId, autoStartUsed]);

  // 拉取当前项目的持久化规划状态，供 UI 显示「实际接受 / 缺失」以及续跑按钮。
  // 行为契约：
  //  - (A) lookup effect 只在 project?.id 变化时跑一次，做 sentinel
  //    推进；把 projectId 写入 ref，回调里比对；项目切换后旧响应不会污染当前项目。
  //    无论结果是 state 还是 undefined，都把 sentinel 标记为当前 projectId，让
  //    auto-start effect 在 lookup 完成后才决定是否起跑（undefined → 允许一次起跑）。
  //    lookup 失败也视为「已尝试」：不阻塞 UI，但也不让 auto-start 在 lookup 出错
  //    时抢跑（lookup 失败通常意味着项目状态未知，不应擅自再生成）。
  //  - (B) 后续状态由 planning:updated 实时事件驱动，不建立 interval；新 renderer
  //    进程或项目切换时由这一次 lookup 补偿订阅建立前可能错过的事件。
  useEffect(() => {
    if (!project || !api()) return;
    const capturedId = project.id;
    currentProjectIdRefForPlanning.current = capturedId;
    const eventVersionAtLookup = planningEventVersionRef.current;
    let cancelled = false;

    // lookup 只跑一次：写本地 cache + 推进 sentinel；后续变化由实时事件到达。
    api()!.planning.state(capturedId).then((s) => {
      // 切换项目后旧响应必须丢弃：用 ref 比对当前 projectId。
      if (currentProjectIdRefForPlanning.current !== capturedId) return;
      if (cancelled) return;
      // lookup 在实时事件之后才返回时，事件携带的状态更新，不能被旧快照覆盖。
      if (planningEventVersionRef.current !== eventVersionAtLookup) return;
      if (s) setPlanningState(s);
      // 注意：s === undefined 时也要标记为 loaded，这样 auto-start 才能在新项目里起跑。
      setPlanningStateLoadedProjectId(capturedId);
    }).catch((error) => {
      if (currentProjectIdRefForPlanning.current !== capturedId) return;
      if (cancelled) return;
      if (planningEventVersionRef.current !== eventVersionAtLookup) return;
      // lookup 失败也视为「已尝试」：不阻塞 UI，但也不让 auto-start 在 lookup 出错时抢跑
      // （lookup 失败通常意味着项目状态未知，不应擅自再生成）。把 sentinel 推进；
      // 下次重新打开该项目会再次执行一次补偿 lookup。
      console.warn("[App] planning.state lookup failed", { projectId: capturedId, error });
      setPlanningStateLoadedProjectId(capturedId);
    });

    return () => {
      cancelled = true;
    };
  }, [project?.id]);

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
  // 渲染层需要把多账号快照 + 当前探测状态整合成一份「账号清单」：
  //  1. 当前如果探测到账号 → 优先使用 vbkLogin.accountName/loginAccount；
  //  2. 否则用 vbkLoginAccounts.current.accountName 兜底；
  //  3. saved 列表始终来自 vbkLoginAccounts.saved（DB 真相）。
  // 注意：上层的 loggedAccounts / currentAccountName 还服务于设置页的
  // 「已记录账号」chip，所以这里继续保留其单一字符串形式。详细的切换 /
  // 忘记都在 vbkLoginAccounts 内做。
  const accountsSnapshot = state.vbkLoginAccounts;
  const snapshotCurrentName = accountsSnapshot.current?.accountName ?? null;
  const detectedName = vbkLogin?.loggedIn ? vbkLogin.accountName ?? null : null;
  const resolvedCurrent = detectedName ?? snapshotCurrentName;
  const loggedAccounts = resolvedCurrent
    ? Array.from(new Set([resolvedCurrent, ...accountsSnapshot.saved.map((entry) => entry.accountName)].filter(Boolean)))
    : accountsSnapshot.saved.map((entry) => entry.accountName);
  const currentAccountName = loggedAccounts[0] || "未登录";
  // 头像缩写：优先账号名最后一个数字（vbk_671205 → 5），没有数字时退到首字符。
  // 之前是 slice(0,1).toUpperCase()，对 vbk_xxx 格式总是 "V"，识别度低。
  const accountInitial = currentAccountName === "未登录"
    ? "未"
    : currentAccountName.match(/\d(?!.*\d)/)?.[0] ?? currentAccountName.slice(0, 1).toUpperCase();

  const browserPlaceholderTitle = isVbkLoggedIn ? "VBK 已登录" : "在 VBK 中完成核查";
  const browserPlaceholderText = isVbkLoggedIn
    ? `${currentAccountName} 已登录，打开右侧页面继续核查当前待办。`
    : "登录后先核查当前待办；系统只会在你确认全部待办后保存产品草稿。";

  // 规划状态摘要：把规划生成态压缩成「恢复提示 + 实际接受 / 缺失模块」两行。
  // 运行中状态还会附上按 PLANNING_STAGES 顺序的阶段进度，供渲染层展示带顺序的进度条。
  const planningRecovery = useMemo(() => {
    if (!planningState) return null;
    const stages = planningState.stages ?? [];
    const accepted: string[] = [];
    const missing: string[] = [];
    for (const entry of stages) {
      for (const m of entry.accepted ?? []) {
        if (!accepted.includes(m.module)) accepted.push(m.module);
      }
      for (const m of entry.rejected ?? []) {
        if (m.status === "missing" && !missing.includes(m.module)) missing.push(m.module);
      }
    }
    const completed = planningState.completedStages ?? [];
    const status = planningState.status;
    const allStagesCompleted = PLANNING_STAGES.every((stage) => completed.includes(stage));
    // 后端 terminal 状态可能先于阶段结果落盘；只有七个阶段全部覆盖时，
    // 才允许前端把它当作整体完成并隐藏生成进度。
    if (status === "completed" && allStagesCompleted) return null;
    let headline = "方案规划未完成。";
    if (status === "running") headline = "方案规划进行中…";
    else if (status === "pending") headline = "方案规划即将开始…";
    else if (status === "failed") headline = "方案规划失败，需要重试。";
    else if (status === "needs_user") headline = "方案规划已暂停，等待补充缺失模块。";
    else if (status === "completed") headline = "方案已生成部分结果，等待继续规划。";
    // 运行中状态额外暴露阶段进度：顺序为 PLANNING_STAGES（共享合约），渲染层负责
    // 把 completed / current / pending 分别贴不同样式与中文标签。
    const stageProgress = status === "running" || status === "pending" || (status === "completed" && !allStagesCompleted)
      ? buildPlanningStageProgress(planningState, PLANNING_STAGES)
      : null;
    const currentStageLabel = planningStageLabel(planningState.currentStage);
    return {
      status,
      headline,
      completed,
      accepted,
      missing,
      currentStage: planningState.currentStage,
      currentStageLabel,
      stageProgress,
      // 简短的「可以续跑 / 已完成 / 需要补齐」三态。
      allStagesCompleted,
      hint: status === "needs_user"
        ? "已自动跳过已接受模块；点击「继续规划」补齐缺失项。"
        : status === "failed"
          ? "请检查 API Key 后点击「重试规划」。"
          : status === "pending"
            ? "系统正在准备下一阶段，完成后会自动跳回产品面板。"
            : status === "completed"
              ? "已保留当前已生成内容；后端状态已结束，需继续规划后才会补齐剩余阶段。"
            : "系统正在分阶段生成方案，完成后会自动跳回产品面板。",
    };
  }, [planningState]);

  /**
   * 用户手动续跑入口：与 auto-start 互斥；每次点击都会调一次 planning.resume，
   * 后端从持久化 currentStage 续跑，不会丢失已合法落地的模块。
   */
  const planningResume = async () => {
    if (!project || !api()) return;
    if (planningBusy) return; // 重复点击锁：与 UI 端 disabled 同源。
    setPlanningBusy(true);
    console.info("[App] planning.resume click", { projectId: project.id, planningStateStatus: planningState?.status, currentStage: planningState?.currentStage });
    setNotice("正在续跑规划…");
    try {
      const result = await api()!.planning.resume(project.id);
      if (result.state) setPlanningState(result.state);
      const acceptedNames = (result.accepted ?? []).slice();
      const rejectedNames = (result.rejected ?? []).map((r) => r.module);
      // 关键可观测性：当 result.status === needs_user 且 persisted accepted
      // 与上一次快照相同（即后端没有推进任何模块），明确告诉用户「本轮未取得进展」，
      // 而不是只显示 assistantReply 本身看不到原因。
      const previouslyAccepted = new Set<string>();
      for (const s of planningState?.stages ?? []) {
        for (const m of s.accepted ?? []) previouslyAccepted.add(m.module);
      }
      const newlyAccepted = acceptedNames.filter((m) => !previouslyAccepted.has(m));
      console.info("[App] planning.resume result", { projectId: project.id, status: result.status, accepted: acceptedNames, newlyAccepted, rejected: rejectedNames });
      const summary = result.assistantReply
        || (acceptedNames.length ? `已接受：${acceptedNames.join("、")}。` : "")
        + (rejectedNames.length ? `缺失：${rejectedNames.join("、")}。` : "");
      if (result.status === "needs_user" && newlyAccepted.length === 0 && acceptedNames.length > 0) {
        setNotice(`续跑未取得进展：${summary}请查看 DevTools 中 [planning] 日志或调整对话后重试。`);
      } else {
        setNotice(summary || "续跑完成");
      }
    } catch (error) {
      console.warn("[App] planning.resume failed", { projectId: project.id, error });
      setNotice(`续跑失败：${(error as { message?: string })?.message ?? String(error)}。请打开 DevTools 查看 [planning] 日志。`);
    } finally {
      setPlanningBusy(false);
    }
  };

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
    vbkLoginAccounts: accountsSnapshot,
    planningRecovery,
    planningResume,
    planningBusy,
  };
}
