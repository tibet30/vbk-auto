import { useCallback, useRef } from "react";
import type { ProductDetail, ProductSummary, VbkLoginStatus } from "../../../shared/contracts.js";
import { api, emptyReadiness } from "../helpers";
import { useAccountBrowserState } from "./domains/account-browser-state";
import { useAiSettingsState } from "./domains/ai-settings-state";
import { useNavigationState } from "./domains/navigation-state";
import { useProductState } from "./domains/product-state";

/**
 * Renderer 状态组合根。
 *
 * 各领域 hook 拥有自己的原始状态；这里仅保留跨领域刷新与迟到响应防护。
 * 返回值继续扁平化，保持现有 view/actions API 不变。
 */
export function useAppStateBase() {
  const apiAvailable = Boolean(api());
  const navigation = useNavigationState();
  const productState = useProductState();
  const accountState = useAccountBrowserState();
  const aiState = useAiSettingsState();
  const collectionScopeRef = useRef("");
  collectionScopeRef.current = `${navigation.view}:${productState.creating ? "creating" : "list"}`;

  const currentLocalProductIdRef = useRef<string | null>(null);
  currentLocalProductIdRef.current = productState.product?.id ?? null;

  const checkVbkLogin = async (refresh = false): Promise<VbkLoginStatus | null> => {
    if (!api()) return null;
    accountState.setCheckingVbkLogin(true);
    try {
      const next = await api()!.browser.status(refresh);
      accountState.setVbkLogin(next);
      return next;
    } catch (error) {
      const next = {
        loggedIn: false,
        message: error instanceof Error ? error.message : "无法检测 VBK 登录状态。",
      };
      accountState.setVbkLogin(next);
      return next;
    } finally {
      accountState.setCheckingVbkLogin(false);
    }
  };

  // 必须保持稳定引用：设置页 effect 依赖该函数，普通 async 箭头会形成刷新循环。
  const refreshVbkLoginAccounts = useCallback(async () => {
    if (!api()) return;
    const requestScope = collectionScopeRef.current;
    accountState.setLoadingLoginAccounts(true);
    try {
      const next = await api()!.browser.listLoginAccounts();
      if (collectionScopeRef.current !== requestScope) return;
      accountState.setVbkLoginAccounts(next);
    } catch (error) {
      if (collectionScopeRef.current !== requestScope) return;
      accountState.setVbkLoginAccounts({ current: null, saved: [] });
      navigation.setNotice(error instanceof Error ? error.message : "读取账号列表失败。");
    } finally {
      if (collectionScopeRef.current !== requestScope) return;
      accountState.setLoadingLoginAccounts(false);
    }
  }, []);

  const refresh = async () => {
    if (!api()) return;
    const requestScope = collectionScopeRef.current;
    const [productResult, taskResult] = await Promise.allSettled([
      api()!.products.list(),
      api()!.workflowTasks.list(),
    ]);
    if (collectionScopeRef.current !== requestScope) return;
    if (taskResult.status === "fulfilled") {
      productState.setWorkflowTasks(taskResult.value);
    }
    if (productResult.status === "fulfilled") {
      const next = productResult.value;
      productState.setProducts(next);
      productState.setProduct((current: ProductDetail | null) =>
        current && next.some((item: ProductSummary) => item.id === current.id) ? current : null);
    }
    if (productResult.status === "rejected") {
      const error = productResult.reason;
      navigation.setNotice(error instanceof Error ? error.message : "无法加载产品列表。");
    } else if (taskResult.status === "rejected") {
      const error = taskResult.reason;
      navigation.setNotice(error instanceof Error ? error.message : "无法加载任务列表。");
    }
  };

  const updateReadiness = async (candidate: ProductDetail | null) => {
    if (!candidate || !api()) return productState.setReadiness(emptyReadiness);
    try {
      const next = await api()!.products.readiness(candidate.id);
      if (currentLocalProductIdRef.current === candidate.id) productState.setReadiness(next);
    } catch (error) {
      navigation.setNotice(error instanceof Error ? error.message : "无法获取录入前检查结果。");
    }
  };

  return {
    apiAvailable,
    ...navigation,
    ...productState,
    ...accountState,
    ...aiState,
    checkVbkLogin,
    refreshVbkLoginAccounts,
    refresh,
    updateReadiness,
  };
}

export type AppStateBase = ReturnType<typeof useAppStateBase>;
