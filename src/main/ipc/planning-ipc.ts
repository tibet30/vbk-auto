/**
 * @deprecated — planning IPC 装配旧入口（legacy）。
 *
 * 状态（v1.1.19 起）：
 *   - 当前正式注册入口是 `registerPlanningV2Ipc`（见 ./planning-v2-ipc.ts）；
 *     每个规划 mutation 现在都委托给 AgentCore 的意图，没有第二套循环。
 *   - 本文件保留**仅**供 git 历史回溯和未来需要按阶段回放旧方案的读路径；
 *     它的 `registerPlanningIpc` 不再被 `main-ipc.ts` 调用。
 *   - 不要把它重新接入装配链路：Electron `ipcMain.handle` 拒绝同 channel
 *     二次注册，会立即抛 "Attempted to register a second handler" —— 这是
 *     想要的 fail-fast 护栏，避免再出现两套规划循环。
 *   - 单元测试用 `src/main/planning/plan-orchestrator.ts` 的 `runPlan`
 *     直接驱动旧阶段的纯函数路径，与本文件 IPC 装配无关。
 *
 * 关联：
 *   - ARCHITECTURE.md §2「旧 planning-ipc / plan-orchestrator 实现仍在仓库中，
 *     但不是当前正式注册的规划入口」；
 *   - 旧测试入口仍在 `test/planning/*`，覆盖单阶段回放、断点恢复等纯函数行为。
 */

import { createPreflightFailureHandler } from "./planning-ipc/preflight-failure.js";
import { createRunPlanning } from "./planning-ipc/run-planning.js";
import { registerIpcHandlers } from "./planning-ipc/ipc-handlers.js";
import type { MainIpcContext } from "./context.js";

/**
 * Legacy 入口。v2 起**不**注册；这里继续保留导出仅为兼容既有单元测试
 * 可能引用同名符号，不会启动任何 IPC handler。
 */
export function registerPlanningIpc(context: MainIpcContext): void {
  const handlePreflightFailure = createPreflightFailureHandler(context);
  const runPlanning = createRunPlanning(context, handlePreflightFailure);
  registerIpcHandlers(context, handlePreflightFailure, runPlanning);
}