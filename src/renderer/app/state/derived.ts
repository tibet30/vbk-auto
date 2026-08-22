import { logInfo, logWarn } from "../../../shared/log-timestamp.js";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  buildPlanningStageProgress,
  initialStageFor,
  planningStageLabel,
} from "../helpers";
import { PLANNING_STAGES } from "../../../shared/contracts-planning.js";
import { api } from "../helpers";
import { hasActiveAiKey } from "../../../shared/ai-provider-config.js";
import type { AppStateBase } from "./base";
import type { PlanningGenerationState } from "../../../shared/contracts-planning.js";
import { shouldAutoStartPlanning } from "./auto-start-policy.js";
import { simulateRecoveryEffectTick } from "./recovery-policy.js";
import { upsertProductToTop } from "./product-list-helper.js";
import { useBrowserDerived } from "./domains/browser-derived";
import { useProductViewDerived } from "./domains/product-view-derived";
import { usePlanningActions } from "./domains/planning-actions";

export function useAppStateDerived(state: AppStateBase) {
  const {
    product,
    setProducts,
    setProduct,
    activeLocalProductId,
    setActiveLocalProductId,
    setNotice,
    setActiveTaskId,
    setVerificationNote,
    setExpandedDayIndexes,
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
    setBasicInfoErrors,
    setBasicInfoDraft,
    setBasicInfoSaving,
    setBasicInfoButlerDefault,
    setBasicInfoServicePhone,
    setBasicInfoButlerLoadedForLocalProductId,
  } = state as AppStateBase & { setNotice: (value: string | null) => void; setActiveTaskId: (id: string | null) => void; };

  // 规划状态：本地缓存 + UI 触发器。auto-start 必须看到 failed/needs_user 不再自动重跑；
  // 用户通过 planning.resume 手动续跑，避免并发触发。
  const [planningState, setPlanningState] = useState<PlanningGenerationState | null>(null);
  const [autoStartUsed, setAutoStartUsed] = useState<string | null>(null);
  const planningActions = usePlanningActions({ product, planningState, setPlanningState, setNotice });
  // Per-product sentinel：标记「planning.state(localProductId) 已对当前 product 完成」。
  // 未完成时 auto-start effect 必须空跑：这样能避免「persisted failed 产品被重新打开」
  // 时 effect 在 lookup 回来前抢跑 planning.start，把已经失败的产品又拉起一次。
  // 切换产品时复位为 null（由下面的 product-switch effect 负责）。
  const [planningStateLoadedLocalProductId, setPlanningStateLoadedLocalProductId] = useState<string | null>(null);
  // 用于 planning.state() 异步回调内做产品 id 比对，避免切换产品后旧响应污染当前产品。
  const currentLocalProductIdRefForPlanning = useRef<string | null>(null);
  // 首次 planning.state 补偿是异步的：若它返回前已收到 planning:updated，旧查询
  // 结果不得反向覆盖实时状态。每个已接受的当前产品事件都递增该版本号。
  const planningEventVersionRef = useRef(0);
  // 此 ref 同时供首次补偿与实时事件使用；产品切换后迟到的状态事件不能污染新产品。
  currentLocalProductIdRefForPlanning.current = product?.id ?? null;

  const browserShouldMount = view === "workspace" && (stage === "vbk" || loginPanelOpen) && Boolean(product || loginPanelOpen);
  const browserDerived = useBrowserDerived(state, browserShouldMount);
  const productViewDerived = useProductViewDerived(state);

  useEffect(() => {
    if (!api()) return;
    void refresh();
    void api()!.settings.get().then(setSettings).catch(() => setNotice("无法读取本机设置。"));
    // 首次登录检测由主进程 vbk:page-ready 事件驱动：页面 SPA 渲染就绪后
    // 主进程发事件，renderer 收到后才调用 checkVbkLogin，避免 DOM 未就绪误判。
    const unsubscribePageReady = api()!.events.onPageReady(() => {
      void checkVbkLogin();
    });
    // 兜底：1.2s 后重试一次，防止 vbk:page-ready 事件因超时未送达。
    const retryLoginCheck = window.setTimeout(() => void checkVbkLogin(), 1200);
    const unsubscribe = api()!.events.onProductUpdated((next) => {
      setProduct((current: typeof product) => current?.id === next.id ? next : current);
      void updateReadiness(next);
      setProducts((prev) => upsertProductToTop(prev, next));
    });
    const unsubscribePlanning = api()!.events.onPlanningStateUpdated((localProductId, next) => {
      if (currentLocalProductIdRefForPlanning.current !== localProductId) return;
      planningEventVersionRef.current += 1;
      setPlanningState(next);
      setPlanningStateLoadedLocalProductId(localProductId);
    });

    return () => {
      window.clearTimeout(retryLoginCheck);
      unsubscribePageReady();
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

  // 启动 / 刷新时恢复最近打开的产品：只持久化 id 不足以让 React 看到
  // ProductDetail，必须再向主进程拉一次权威数据。
  //
  // 关键不变量（详见 ./recovery-policy.ts 的纯函数决策）：
  //   - 只在 view === "workspace" 时恢复。切到 products / settings / operation-log 后
  //     用户明确离开详情，effect 必须短路，不再发起请求或回填 product；
  //   - 同一会话内只尝试一次（hasAttempted gate）：点"工作台"按钮
  //     （setProduct(null) + setView("workspace")）后 view 仍是 workspace，如果
  //     只看 view 会再次触发，把刚被用户清掉的产品又塞回来。点击"产品"/"设置"/
  //     "操作日志"时则由 view gate 拦截；
  //   - 用户在初始化期间手动 openProduct(A) 时同样消费本会话恢复机会——
  //     主动接管产品选择之后，session 内不应再自动恢复，否则清掉 product
  //     回 workspace 又被拉回详情（核心防回填，详见 simulateRecoveryEffectTick）；
  //   - 产品不存在 / 主进程报错 → 清掉残留 id + activeLocalProductId，让下次启动不再
  //     尝试恢复；但 view 已切走时不清理（用户可能想用 localStorage 里的 id
  //     重新打开）；
  //   - 异步取消：cleanup 把 cancelled 置 true，.then() / .catch() 跳过；用
  //     currentViewForRecoveryRef + currentActiveLocalProductIdForRecoveryRef 在
  //     in-flight 期间 view / activeLocalProductId 切换时再次确认（refs 在每次 render
  //     同步更新，闭包读到的总是最新值），避免旧请求覆盖目标产品。
  const recoveryAttemptedRef = useRef(false);
  const currentViewForRecoveryRef = useRef<typeof view>(view);
  const currentActiveLocalProductIdForRecoveryRef = useRef<string | null>(activeLocalProductId);
  currentViewForRecoveryRef.current = view;
  currentActiveLocalProductIdForRecoveryRef.current = activeLocalProductId;

  useEffect(() => {
    const decision = simulateRecoveryEffectTick({
      hasApi: Boolean(api()),
      view,
      hasProduct: Boolean(product),
      hasActiveLocalProductId: Boolean(activeLocalProductId),
      hasAttempted: recoveryAttemptedRef.current,
    });
    recoveryAttemptedRef.current = decision.nextHasAttempted;
    if (!decision.shouldRequest) return;
    const targetId = activeLocalProductId as string;
    let cancelled = false;
    void api()!.products.get(targetId).then((detail) => {
      if (cancelled) return;
      // 即便 cancelled 标志位为 false，也再校验一次当前 view + activeLocalProductId：
      // 用户可能在 in-flight 期间主动退出详情页（setProduct(null) → sync effect
      // 把 activeLocalProductId 清掉）或切到非 workspace 视图，此时不能把已拉到手的
      // 旧产品再塞回去。
      if (currentViewForRecoveryRef.current !== "workspace") return;
      if (currentActiveLocalProductIdForRecoveryRef.current !== targetId) return;
      setProduct(detail);
    }).catch(() => {
      if (cancelled) return;
      // view 已切走时不清理 localStorage / activeLocalProductId：用户可能还在用
      // products 视图，需要保留 id 以便重新打开。
      if (currentViewForRecoveryRef.current !== "workspace") return;
      if (currentActiveLocalProductIdForRecoveryRef.current !== targetId) return;
      // 产品已被删除或主进程暂时不可达：清掉 localStorage，让 UI 回落到
      // 工作台首页（AppWorkspaceHomePage），下次启动不再尝试恢复。
      try { localStorage.removeItem("vbk:activeLocalProductId"); } catch { /* 忽略 */ }
      setActiveLocalProductId(null);
    });
    return () => { cancelled = true; };
    // activeLocalProductId / product?.id / view 都进 deps：用户在拉取期间切走时 effect
    // 会 cleanup + 重新跑，重新跑时会被 policy 的几条短路拦住（product 已存在 /
    // activeLocalProductId 已清 / view 非 workspace / 已 attempt 过），不再发起多余请求。
  }, [activeLocalProductId, product?.id, view]);

  useEffect(() => {
    void updateReadiness(product);
  }, [product?.id, product?.updatedAt]);

  useEffect(() => {
    setVerificationNote("");
  }, [state.activeTaskId]);

  // 切换产品时清空核查选择，避免上一个产品残留的 activeTaskId 落到新产品。
  // 同时复位 planning 相关本地缓存，保证 sentinel / autoStartUsed 不会跨产品残留；
  // planning.state 由下一个 effect 异步拉取，sentinel 复位为 null 让 auto-start 等它回来。
  useEffect(() => {
    if (!product) return;
    setActiveTaskId(null);
    setVerificationNote("");
    setStage(initialStageFor(product.status));
    setExpandedDayIndexes(new Set([0]));
    setPlanningState(null);
    setAutoStartUsed(null);
    setPlanningStateLoadedLocalProductId(null);
    // 基础信息模块的缓存（butler 默认联系人、临时草稿、错误信息）也随产品复位。
    // basicInfoActions 不在这个文件里调用；调用方从 useAppActions() 拿到。
    setBasicInfoErrors({});
    setBasicInfoDraft({});
    setBasicInfoSaving(null);
    setBasicInfoButlerDefault(null);
    setBasicInfoServicePhone(null);
    setBasicInfoButlerLoadedForLocalProductId(null);
  }, [product?.id]);

  // 产品进入兜底：进入仍为空草稿的产品时自动触发一次 staged planning 生成。
  // 规划走 planner.start，由后端分阶段 + bounded retry；ai:send 仍保留供后续多轮对话。
  // 关键不变量：必须等到 planning.state(localProductId) 已对当前 localProductId 完成（sentinel
  // 命中）；在此之前空跑。否则 persisted failed 的产品被重新打开时，会在 lookup 还没
  // 回来前抢跑一次 planning.start，把失败的产品又拉起一次。决策逻辑抽出到
  // shouldAutoStartPlanning，便于纯函数单测。
  useEffect(() => {
    if (!product || !api()) return;
    if (!shouldAutoStartPlanning({
      hasProduct: true,
      localProductId: product.id,
      hasUserMessages: product.messages.some((message: { role: string }) => message.role === "user"),
      hasItinerary: Array.isArray(product.product.itinerary) && (product.product.itinerary as unknown[]).length > 0,
      hasAiKey: hasActiveAiKey(settings),
      planningStateLoadedLocalProductId,
      planningState,
      autoStartUsed,
    })) return;
    setAutoStartUsed(product.id);
    logInfo("[App] auto-planning fallback for empty product", { localProductId: product.id, provider: settings?.aiProvider });
    const capturedLocalProductId = product.id;
    let cancelled = false;
    // planning.start IPC 会同步等待整轮 AI；先放入本地 pending，让 UI 立刻显示
    // 0/7；后续持久化状态会由 planning:updated 事件直接推送。
    setPlanningState({
      localProductId: capturedLocalProductId,
      currentStage: "skeleton",
      completedStages: [],
      stages: [],
      status: "pending",
      resumeAt: new Date().toISOString(),
    });
    void api()!.planning.start(capturedLocalProductId).then((result) => {
      if (cancelled || currentLocalProductIdRefForPlanning.current !== capturedLocalProductId) return;
      if (result.state) setPlanningState(result.state);
      if (result.status === "failed") {
        // preflight 失败（例如密钥不可用）→ IPC 也会返回 normal PlanningRunResult；
        // 这里显式 setNotice，让 recovery strip 的「重试规划」按钮有上下文；
        // assistantReply 已是 provider-neutral 中文，不会泄露密钥 / 密文。
        setNotice(result.assistantReply || "方案规划未能启动，请检查 API Key 后重试。");
      }
    }).catch((error) => {
      if (cancelled || currentLocalProductIdRefForPlanning.current !== capturedLocalProductId) return;
      logWarn("[App] planning.start failed", error);
      setNotice(`方案规划异常：${(error as { message?: string })?.message ?? String(error)}`);
    });
    return () => {
      cancelled = true;
    };
  }, [product?.id, settings?.aiProvider, settings?.hasMiniMaxKey, settings?.hasDeepSeekKey, planningState, planningStateLoadedLocalProductId, autoStartUsed]);

  // 拉取当前产品的持久化规划状态，供 UI 显示「实际接受 / 缺失」以及续跑按钮。
  // 行为契约：
  //  - (A) lookup effect 只在 product?.id 变化时跑一次，做 sentinel
  //    推进；把 localProductId 写入 ref，回调里比对；产品切换后旧响应不会污染当前产品。
  //    无论结果是 state 还是 undefined，都把 sentinel 标记为当前 localProductId，让
  //    auto-start effect 在 lookup 完成后才决定是否起跑（undefined → 允许一次起跑）。
  //    lookup 失败也视为「已尝试」：不阻塞 UI，但也不让 auto-start 在 lookup 出错
  //    时抢跑（lookup 失败通常意味着产品状态未知，不应擅自再生成）。
  //  - (B) 后续状态由 planning:updated 实时事件驱动，不建立 interval；新 renderer
  //    进程或产品切换时由这一次 lookup 补偿订阅建立前可能错过的事件。
  useEffect(() => {
    if (!product || !api()) return;
    const capturedId = product.id;
    currentLocalProductIdRefForPlanning.current = capturedId;
    const eventVersionAtLookup = planningEventVersionRef.current;
    let cancelled = false;

    // lookup 只跑一次：写本地 cache + 推进 sentinel；后续变化由实时事件到达。
    api()!.planning.state(capturedId).then((s) => {
      // 切换产品后旧响应必须丢弃：用 ref 比对当前 localProductId。
      if (currentLocalProductIdRefForPlanning.current !== capturedId) return;
      if (cancelled) return;
      // lookup 在实时事件之后才返回时，事件携带的状态更新，不能被旧快照覆盖。
      if (planningEventVersionRef.current !== eventVersionAtLookup) return;
      if (s) setPlanningState(s);
      // 注意：s === undefined 时也要标记为 loaded，这样 auto-start 才能在新产品里起跑。
      setPlanningStateLoadedLocalProductId(capturedId);
    }).catch((error) => {
      if (currentLocalProductIdRefForPlanning.current !== capturedId) return;
      if (cancelled) return;
      if (planningEventVersionRef.current !== eventVersionAtLookup) return;
      // lookup 失败也视为「已尝试」：不阻塞 UI，但也不让 auto-start 在 lookup 出错时抢跑
      // （lookup 失败通常意味着产品状态未知，不应擅自再生成）。把 sentinel 推进；
      // 下次重新打开该产品会再次执行一次补偿 lookup。
      logWarn("[App] planning.state lookup failed", { localProductId: capturedId, error });
      setPlanningStateLoadedLocalProductId(capturedId);
    });

    return () => {
      cancelled = true;
    };
  }, [product?.id]);

  useEffect(() => {
    const conversation = conversationRef.current;
    if (conversation) conversation.scrollTop = conversation.scrollHeight;
  }, [product?.messages.length, state.loading]);

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

  return {
    ...productViewDerived,
    ...browserDerived,
    planningRecovery,
    ...planningActions,
  };
}
