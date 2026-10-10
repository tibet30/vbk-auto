/**
 * per-field 错误文案清理（手动清错 / 切产品 / 模块卸载时调用）。
 */

import type { AppState } from "../../state/useAppState.js";

export function makeClearError(deps: { setBasicInfoErrors: AppState["setBasicInfoErrors"] }) {
  const { setBasicInfoErrors } = deps;
  return function clearError(field: string) {
    setBasicInfoErrors((prev) => {
      if (!prev[field]) return prev;
      const next = { ...prev };
      delete next[field];
      return next;
    });
  };
}

export function makeClearAllErrors(deps: { setBasicInfoErrors: AppState["setBasicInfoErrors"] }) {
  const { setBasicInfoErrors } = deps;
  return function clearAllErrors() {
    setBasicInfoErrors({});
  };
}