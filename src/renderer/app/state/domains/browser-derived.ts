import { useEffect, useLayoutEffect } from "react";
import { api } from "../../helpers";
import type { AppStateBase } from "../base";

/** BrowserView 布局、可见性、URL 同步与账号展示派生。 */
export function useBrowserDerived(state: AppStateBase, browserShouldMount: boolean) {
  const {
    browserRef, view, loginPanelOpen, stage, product, vbkLogin, browserOpen,
    setBrowserOpen, setBrowserUrl,
  } = state;

  useLayoutEffect(() => {
    const target = browserRef.current;
    if (!target || !api() || !browserShouldMount) return;
    let frame = 0;
    const update = () => {
      const box = target.getBoundingClientRect();
      const width = Math.round(box.width);
      const height = Math.round(box.height);
      if (width <= 0 || height <= 0) return;
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
  }, [browserShouldMount, loginPanelOpen, stage, view, product?.id]);

  useEffect(() => {
    if (!api()) return;
    void api()!.browser.setVisible(Boolean(view === "workspace" && browserShouldMount)).catch(() => {});
  }, [view, browserShouldMount]);

  useEffect(() => {
    if (view === "workspace" && product && vbkLogin?.loggedIn && stage === "vbk" && !browserOpen) {
      setBrowserOpen(true);
    }
  }, [browserOpen, product, vbkLogin?.loggedIn, view, stage]);

  useEffect(() => {
    if (!api() || !browserShouldMount || view !== "workspace") return;
    let cancelled = false;
    const refreshUrl = async () => {
      if (cancelled) return;
      const next = await api()!.browser.currentUrl().catch(() => "");
      if (!cancelled && next) setBrowserUrl((prev: string) => (prev === next ? prev : next));
    };
    void refreshUrl();
    const interval = window.setInterval(() => { void refreshUrl(); }, 1500);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [browserShouldMount, view]);

  const accountsSnapshot = state.vbkLoginAccounts;
  const snapshotCurrentName = accountsSnapshot.current?.accountName ?? null;
  const detectedName = vbkLogin?.loggedIn ? vbkLogin.accountName ?? null : null;
  const resolvedCurrent = detectedName ?? snapshotCurrentName;
  const loggedAccounts = resolvedCurrent
    ? Array.from(new Set([resolvedCurrent, ...accountsSnapshot.saved.map((entry) => entry.accountName)].filter(Boolean)))
    : accountsSnapshot.saved.map((entry) => entry.accountName);
  const currentAccountName = loggedAccounts[0] || "未登录";
  const accountInitial = currentAccountName === "未登录"
    ? "未"
    : currentAccountName.match(/\d(?!.*\d)/)?.[0] ?? currentAccountName.slice(0, 1).toUpperCase();
  const isVbkLoggedIn = Boolean(vbkLogin?.loggedIn);

  return {
    isVbkLoggedIn,
    loggedAccounts,
    currentAccountName,
    accountInitial,
    browserPlaceholderTitle: isVbkLoggedIn ? "VBK 已登录" : "在 VBK 中完成核查",
    browserPlaceholderText: isVbkLoggedIn
      ? `${currentAccountName} 已登录，打开右侧页面继续核查当前待办。`
      : "登录后先核查当前待办；系统只会在你确认全部待办后保存产品草稿。",
    vbkLoginAccounts: accountsSnapshot,
  };
}
