/**
 * 规划相关 IPC 装配（barrel）：
 *   - registerPlanningIpc：调三个子模块装配 preflight 兜底、runPlanning 主流程、
 *     IPC handler 注册。
 *   - 规划算法位于 src/main/planning/*；本文件只负责 IPC 装配、持久化与广播。
 *
 * 子文件分工：
 *   - preflight-failure.ts：runPlan / preflight 抛错时的统一出口（failed state +
 *     taskStatus=failed 的 assistant 消息 + syncProductStatusAfterFailure + emitProduct）；
 *   - run-planning.ts：runPlanning 主流程（assertIdle + runExclusive + planner 构造 +
 *     runPlan + 后处理 + 消息写回）；
 *   - postprocess.ts：规划 completed 后封面 / 用车资源自动补齐；
 *   - stable-result.ts：持久化 completed → PlanningRunResult 形状还原；
 *   - ipc-handlers.ts：planning:start / planning:resume / planning:state 三个 handler。
 */

import { createPreflightFailureHandler } from "./planning-ipc/preflight-failure.js";
import { createRunPlanning } from "./planning-ipc/run-planning.js";
import { registerIpcHandlers } from "./planning-ipc/ipc-handlers.js";
import type { MainIpcContext } from "./context.js";

export function registerPlanningIpc(context: MainIpcContext): void {
  const handlePreflightFailure = createPreflightFailureHandler(context);
  const runPlanning = createRunPlanning(context, handlePreflightFailure);
  registerIpcHandlers(context, handlePreflightFailure, runPlanning);
}