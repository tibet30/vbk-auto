/**
 * planning-ipc.ts 的 IPC handler 装配层：
 *   - planning:start：受限 restore → 写 pending state → 调 runPlanning；
 *   - planning:resume：先 load state；completed+POI 齐全时返回 stable completed；
 *     否则受限 restore → 调 runPlanning；
 *   - planning:state：直接返回持久化 state。
 *
 * Renderer 的 disabled 只能防正常点击；IPC 仍可能因双击落在同一渲染帧、
 * 自动恢复或预加载层调用而并发到达。锁必须在主进程、且按产品持有，避免
 * 两次 runPlan 同时读到同一 completed partial 状态并重复生成/写模块。
 */

import { PLANNING_STAGES } from "../../../shared/contracts.js";
import type { PlanningGenerationState, PlanningRunResult } from "../../../shared/contracts.js";
import { hasIncompleteItineraryPois } from "../../planning/poi-enrichment.js";
import { restoreProductToPlanningForRetry } from "../../planning/product-status-sync.js";
import { logInfo, logWarn } from "../../../shared/log-timestamp.js";
import { secureIpcMain as ipcMain } from "../../infrastructure/ipc-sender.js";
import type { MainIpcContext } from "../context.js";
import { buildStableCompletedResult } from "./stable-result.js";

export function registerIpcHandlers(
  context: MainIpcContext,
  handlePreflightFailure: (id: string, error: unknown) => PlanningRunResult,
  runPlanning: (id: string) => Promise<PlanningRunResult>,
): void {
  const { db, emitPlanningState } = context;

  /** preflight / runPlan 抛错时的统一出口：见 preflight-failure.ts。 */

  /** 共享包装：start / resume 都走这条路径，保证 preflight 行为一致。 */
  function assertPlanningIdle(localProductId: string): void {
    context.productWorkflows.assertIdle(localProductId, "planning");
  }

  ipcMain.handle("planning:start", (_event, localProductId: string) => {
    // fresh start 语义：先调一次受限 restore —— 仅当 products.status=blocked 且
    // 旧持久化 planning_generation ∈ {failed, needs_user} 时把 products.status
    // 改回 planning，再覆盖写 pending state。
    // 必须先 restore 后 save pending：否则 pending state 会先洗掉旧的
    // failed/needs_user 标记，后续 runPlan=completed 走 syncProductStatusAfterRunPlan
    // 时因 products.status=blocked 错过 planning→review 推送，UI 永远停在 blocked。
    logInfo(`[planning] ipc.start localProductId=${localProductId}`);
    // 在任何状态写入前检查，避免第二个 start 把首个运行中的 state 覆盖为 pending。
    assertPlanningIdle(localProductId);
    const existingState = db.loadPlanningState(localProductId);
    if (existingState) {
      restoreProductToPlanningForRetry(db, localProductId, existingState.status);
    }
    const pendingState: PlanningGenerationState = {
      localProductId,
      currentStage: "skeleton",
      completedStages: [],
      stages: [],
      status: "pending",
      resumeAt: new Date().toISOString(),
    };
    db.savePlanningState(pendingState);
    emitPlanningState(pendingState);
    return runPlanning(localProductId);
  });

  ipcMain.handle("planning:resume", (_event, localProductId: string) => {
    // resume 必须先 load state：没有持久化记录时没有可恢复上下文，盲目跑
    // 等同 planning:start，应由调用方显式改走 start；这里直接抛错让 IPC
    // 拒绝而不是静默写一条 pending。
    logInfo(`[planning] ipc.resume localProductId=${localProductId}`);
    let existingState: PlanningGenerationState | undefined;
    try {
      existingState = db.loadPlanningState(localProductId);
    } catch (error) {
      logWarn(`[planning] ipc.resume load_failed localProductId=${localProductId}`, error);
      return handlePreflightFailure(localProductId, error);
    }
    if (!existingState) {
      logWarn(`[planning] ipc.resume no_state localProductId=${localProductId}`);
      throw new Error(`planning:resume 拒绝：产品 ${localProductId} 没有持久化规划状态，请改用 planning:start`);
    }
    const allStagesCompleted = PLANNING_STAGES.every((stage) => existingState.completedStages.includes(stage));
    const productHasIncompletePois = hasIncompleteItineraryPois(db.getProduct(localProductId)?.product ?? {});
    if (existingState.status === "completed" && allStagesCompleted && !productHasIncompletePois) {
      // 只有所有阶段完成且 itinerary POI 已齐全的产品才不应被 resume 重跑，避免
      // 重复调 AI、重复写消息、再次触发 syncProductStatusAfterRunPlan。历史 completed
      // 草稿仍有空 POI 时必须进入 runPlanning 的 completed backfill 分支；该分支只查
      // POI，不会重跑 planner / AI 阶段。
      logInfo(`[planning] ipc.resume stable_completed localProductId=${localProductId} currentStage=${existingState.currentStage} completedStages=${existingState.completedStages.join(",")}`);
      return buildStableCompletedResult(existingState);
    }
    // 其他状态：受限 restore —— 仅当 products.status=blocked 且持久化
    // planning_generation ∈ {failed, needs_user} 时才把 products.status
    // 恢复为 planning；其他来源的 blocked（自动化孤儿、运营手工、
    // planning_gen=running / pending 等）保持原状。
    try {
      restoreProductToPlanningForRetry(db, localProductId, existingState.status);
    } catch (error) {
      logWarn(`[planning] ipc.resume restore_failed localProductId=${localProductId}`, error);
      return handlePreflightFailure(localProductId, error);
    }
    logInfo(`[planning] ipc.resume proceed localProductId=${localProductId} currentStage=${existingState.currentStage} status=${existingState.status} completedStages=${existingState.completedStages.join(",")}`);
    return runPlanning(localProductId);
  });

  ipcMain.handle("planning:state", (_event, localProductId: string) => {
    try {
      const state = db.loadPlanningState(localProductId);
      logInfo(`[planning] ipc.state localProductId=${localProductId} status=${state?.status ?? "none"} currentStage=${state?.currentStage ?? "none"}`);
      return state;
    } catch (error) {
      logWarn(`[planning] ipc.state failed localProductId=${localProductId}`, error);
      throw error;
    }
  });
}