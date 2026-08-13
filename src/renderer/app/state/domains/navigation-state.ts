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
  const [expandedDayIndex, setExpandedDayIndex] = useState<number | null>(0);
  const browserRef = useRef<HTMLDivElement>(null);
  const conversationRef = useRef<HTMLDivElement>(null);

  return {
    view, setView,
    notice, setNotice,
    expandedDayIndex, setExpandedDayIndex,
    browserRef, conversationRef,
  };
}
