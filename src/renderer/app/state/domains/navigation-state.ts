import { useCallback, useRef, useState } from "react";

export type AppView = "workspace" | "products" | "settings" | "operation-log";
const VIEW_STORAGE_KEY = "vbk:view";

function readInitialView(): AppView {
  try {
    const raw = localStorage.getItem(VIEW_STORAGE_KEY);
    if (raw === "workspace" || raw === "products" || raw === "settings" || raw === "operation-log") return raw;
  } catch { /* localStorage 在部分 Electron 启动阶段不可用 */ }
  return "workspace";
}

export function useNavigationState() {
  const [view, setViewRaw] = useState<AppView>(readInitialView);
  const setView = useCallback((next: AppView) => {
    try { localStorage.setItem(VIEW_STORAGE_KEY, next); } catch { /* 忽略 */ }
    setViewRaw(next);
  }, []);
  const [notice, setNotice] = useState<string | null>(null);
  // 每日行程展开的天集合：支持多天同时展开（不互斥），默认只展开第一天。
  const [expandedDayIndexes, setExpandedDayIndexes] = useState<Set<number>>(() => new Set([0]));
  const browserRef = useRef<HTMLDivElement>(null);
  const conversationRef = useRef<HTMLDivElement>(null);

  return {
    view, setView,
    notice, setNotice,
    expandedDayIndexes, setExpandedDayIndexes,
    browserRef, conversationRef,
  };
}
