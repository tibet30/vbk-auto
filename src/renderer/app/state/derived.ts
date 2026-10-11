import { logWarn } from "../../../shared/log-timestamp.js";
import { useEffect, useMemo, useRef, useState } from "react";
import { api, initialStageFor } from "../helpers";
import type { AppStateBase } from "./base";
import type { PlanningGenerationState } from "../../../shared/contracts-planning.js";
import {
  shouldHandleVbkPageReady,
  shouldRefreshCollections,
} from "./collection-refresh-policy.js";
import { useRecentProductRecovery } from "./recent-product-recovery.js";
import { useWorkspacePlanning } from "./workspace-planning-subscription.js";
import { workspaceSnapshots } from "./workspace-snapshot-store.js";
import { buildPlanningRecovery } from "./planning-recovery.js";
import { subscribeCollectionLiveUpdates } from "./collection-live-updates.js";
import { useBrowserDerived } from "./domains/browser-derived";
import { useProductViewDerived } from "./domains/product-view-derived";
import { usePlanningActions } from "./domains/planning-actions";

export function useAppStateDerived(state: AppStateBase) {
  const {
    product,
    creating,
    workflowTasks,
    setProducts,
    setWorkflowTasks,
    setProduct,
    activeLocalProductId,
    setActiveLocalProductId,
    setNotice,
    setActiveTaskId,
    setVerificationNote,
    setExpandedDayIndexes,
    setSettings,
    setStage,
    checkVbkLogin,
    refresh,
    updateReadiness,
    browserRef,
    conversationRef,
    setBrowserOpen,
    setVbkLogin,
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

  const [planningState, setPlanningState] = useState<PlanningGenerationState | null>(null);
  const planningActions = usePlanningActions({ product, planningState, setPlanningState, setNotice });
  // 用于 planning.state() 异步回调内做产品 id 比对，避免切换产品后旧响应污染当前产品。
  const currentLocalProductIdRefForPlanning = useRef<string | null>(null);
  const currentViewRef = useRef(view);
  const currentCreatingRef = useRef(creating);
  const refreshRef = useRef(refresh);
  // 首次 planning.state 补偿是异步的：若它返回前已收到 planning:updated，旧查询
  // 结果不得反向覆盖实时状态。每个已接受的当前产品事件都递增该版本号。
  const planningEventVersionRef = useRef(0);
  // 此 ref 同时供首次补偿与实时事件使用；产品切换后迟到的状态事件不能污染新产品。
  currentLocalProductIdRefForPlanning.current = product?.id ?? null;
  currentViewRef.current = view;
  currentCreatingRef.current = creating;
  refreshRef.current = refresh;

  const browserShouldMount = view === "workspace" && (stage === "vbk" || loginPanelOpen) && Boolean(product || loginPanelOpen);
  const loginPanelOpenRef = useRef(loginPanelOpen);
  loginPanelOpenRef.current = loginPanelOpen;
  const browserDerived = useBrowserDerived(state, browserShouldMount);
  const productViewDerived = useProductViewDerived(state);
  useEffect(() => {
    if (!api()) return;
    void api()!.settings.get().then(setSettings).catch(() => setNotice("无法读取本机设置。"));
    // 首次登录检测由主进程 vbk:page-ready 事件驱动：页面 SPA 渲染就绪后
    // 主进程发事件，renderer 收到后才调用 checkVbkLogin，避免 DOM 未就绪误判。
    const unsubscribePageReady = api()!.events.onPageReady(() => {
      if (!shouldHandleVbkPageReady(currentViewRef.current)) return;
      if (loginPanelOpenRef.current) return;
      void checkVbkLogin();
    });
    // 兜底：1.2s 后重试一次，防止 vbk:page-ready 事件因超时未送达。
    const retryLoginCheck = window.setTimeout(() => {
      if (!shouldHandleVbkPageReady(currentViewRef.current)) return;
      if (loginPanelOpenRef.current) return;
      void checkVbkLogin();
    }, 1200);
    const unsubscribeCollections = subscribeCollectionLiveUpdates({
      events: api()!.events,
      state: { setProduct, setProducts, setWorkflowTasks, updateReadiness, setReadiness: state.setReadiness },
      current: () => ({
        view: currentViewRef.current,
        creating: currentCreatingRef.current,
        localProductId: currentLocalProductIdRefForPlanning.current,
      }),
    });

    return () => {
      window.clearTimeout(retryLoginCheck);
      unsubscribePageReady();
      unsubscribeCollections();
    };
  }, []);

  useEffect(() => {
    if (!shouldRefreshCollections(view, creating)) return;
    void refreshRef.current();
  }, [view, creating]);

  useRecentProductRecovery(state);
  useWorkspacePlanning(product?.id, setPlanningState);

  useEffect(() => {
    if (api()?.workspace && product) {
      const snapshot = workspaceSnapshots.get(product.id);
      if (snapshot) state.setReadiness(snapshot.readiness);
      return;
    }
    void updateReadiness(product);
  }, [product?.id, product?.updatedAt]);

  useEffect(() => {
    setVerificationNote("");
  }, [state.activeTaskId]);

  // 切换产品时清空核查选择，避免上一个产品残留的 activeTaskId 落到新产品。
  // 同时复位 planning 相关本地缓存；planning.state 由下一个 effect 异步拉取。
  useEffect(() => {
    if (!product) return;
    setActiveTaskId(null);
    setVerificationNote("");
    setStage(initialStageFor(product.status));
    setExpandedDayIndexes(new Set([0]));
    setPlanningState(null);
    // 基础信息模块的缓存（butler 默认联系人、临时草稿、错误信息）也随产品复位。
    // basicInfoActions 不在这个文件里调用；调用方从 useAppActions() 拿到。
    setBasicInfoErrors({});
    setBasicInfoDraft({});
    setBasicInfoSaving(null);
    setBasicInfoButlerDefault(null);
    setBasicInfoServicePhone(null);
    setBasicInfoButlerLoadedForLocalProductId(null);
  }, [product?.id]);

  useEffect(() => {
    const conversation = conversationRef.current;
    if (conversation && conversation.scrollTop + conversation.clientHeight < conversation.scrollHeight) {
      conversation.scrollTop = conversation.scrollHeight;
    }
  }, [product?.messages.length, state.loading]);

  const planningRecovery = useMemo(() => buildPlanningRecovery(planningState), [planningState]);

  const currentWorkflowTask = useMemo(() => {
    if (!product) return null;
    // 详情页会接收 workflow-task:updated；列表在 workspace 视图不会高频刷新。
    // 因此必须优先使用产品上刚收到的任务，避免初始列表的旧「运行中 0%」
    // 覆盖当前的 waiting_approval / needs_attention 等真实状态。
    return product.workflowTask
      ?? workflowTasks.find((task) => task.localProductId === product.id)
      ?? null;
  }, [product?.id, product?.workflowTask, workflowTasks]);

  return {
    ...productViewDerived,
    ...browserDerived,
    planningRecovery,
    currentWorkflowTask,
    ...planningActions,
  };
}
