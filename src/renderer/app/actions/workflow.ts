/**
 * 汇总 workspace 工作流所需的所有 action（research 核查、自动化控制、VBK 浏览器交互、登录等）。
 * 渲染层从 useWorkflowHandlers() 拿到这些 handler 即可，不需要关心 IPC / 状态拼装细节。
 *
 * 现有 action 大致分类：
 *  - 核查与确认：confirmTask / resolveVehicleTask / refreshResearchIssues
 *  - 自动化控制：startAutomation / stopAutomation / retryOnePhaseAutomation
 *  - VBK 浏览器导航：openSection
 *  - 多账号登录：openLogin / addNewLogin / switchAccount / forgetAccount / logoutVbk
 *  - 路由与产品视图切换：openProductList / startCreateProduct / openStage
 *
 * 子文件：
 *   - workflow/research.ts   : confirmTask / resolveVehicleTask / refreshResearchIssues；
 *   - workflow/automation.ts : startAutomation / stopAutomation / openSection /
 *                              retryOnePhaseAutomation；
 *   - workflow/login.ts      : openLogin / addNewLogin / switchAccount / forgetAccount /
 *                              showVbkBrowser / logoutVbk；
 *   - workflow/routing.ts    : openProductList / startCreateProduct / openStage；
 *   - workflow/types.ts      : WorkflowDeps + WorkflowHandlers 公共类型。
 */

import type { AppState } from "../state/useAppState";
import { buildResearchHandlers } from "./workflow/research.js";
import { buildAutomationHandlers } from "./workflow/automation.js";
import { buildLoginHandlers } from "./workflow/login.js";
import { buildRoutingHandlers } from "./workflow/routing.js";

export function useWorkflowHandlers(state: AppState) {
  const researchDeps = { state };
  const loginHandlers = buildLoginHandlers(researchDeps);
  const fullDeps = { state, openLogin: loginHandlers.openLogin };
  return {
    ...buildResearchHandlers(fullDeps),
    ...buildAutomationHandlers(researchDeps),
    ...buildLoginHandlers(researchDeps),
    ...buildRoutingHandlers(researchDeps),
  };
}