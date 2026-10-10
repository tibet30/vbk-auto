/**
 * workflow handlers 共享 setter 类型 + 内部状态参数：
 *   - WorkflowHandlers：所有 handler 返回给渲染层的统一签名；
 *   - WorkflowDeps：从 useAppState 解构出的最小依赖（state 字段名 + setter）。
 *
 * 子文件（research.ts / automation.ts / login.ts / routing.ts）只接受
 * `WorkflowDeps` 切片，返回 void 即可；上层 useWorkflowHandlers 负责合并。
 */

import type { AppState } from "../../state/useAppState";

export interface WorkflowDeps {
  state: AppState;
  /** openLogin 由 login.ts 提供，注入给 research.ts 让 resolveVehicleTask 复用。 */
  openLogin?: () => void;
}

export type WorkflowHandlers = {
  confirmTask: () => Promise<void>;
  refreshResearchIssues: () => Promise<void>;
  resolveVehicleTask: () => Promise<void>;
  startAutomation: () => Promise<void>;
  stopAutomation: () => Promise<void>;
  openSection: (section: import("../../helpers").VbkNavSection) => Promise<void>;
  retryOnePhaseAutomation: (sectionKey: string, phaseName: string) => Promise<void>;
  openLogin: () => void;
  addNewLogin: () => Promise<void>;
  switchAccount: (accountKey: string) => Promise<void>;
  forgetAccount: (accountKey: string) => Promise<void>;
  showVbkBrowser: () => void;
  logoutVbk: () => Promise<void>;
  openProductList: () => void;
  startCreateProduct: () => void;
  openStage: (next: "review" | "vbk") => void;
};