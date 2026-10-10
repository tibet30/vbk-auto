/**
 * planning-ipc.ts 的"preflight 失败兜底"工具：
 *   - handlePreflightFailure：把任意 preflight / runPlan 抛出的 error 包成
 *     status=failed 的持久化 state + 必要时写 taskStatus='failed' 的 assistant
 *     消息 + 同步 products.status + emitProduct；返回 status='failed' 的 PlanningRunResult。
 *
 * 产品不存在时：仍持久化 failed state 并返回失败结果，但跳过 addMessage /
 * syncProductStatusAfterFailure / emitProduct —— 否则消息表会出现孤儿
 * local_product_id 行，破坏 conversations 反查产品的语义一致性。
 */

import type { PlanningGenerationState, PlanningRunResult } from "../../../shared/contracts.js";
import { logWarn } from "../../../shared/log-timestamp.js";
import { buildPreflightFailureState } from "../../planning/preflight-failure.js";
import { syncProductStatusAfterFailure } from "../../planning/product-status-sync.js";
import type { MainIpcContext } from "../context.js";

export function createPreflightFailureHandler(context: MainIpcContext) {
  return function handlePreflightFailure(localProductId: string, error: unknown): PlanningRunResult {
    const { db, emitPlanningState } = context;
    const product = db.getProduct(localProductId);
    const existing = db.loadPlanningState(localProductId);
    const baseState: PlanningGenerationState = existing ?? {
      localProductId,
      currentStage: "skeleton",
      completedStages: [],
      stages: [],
      status: "pending",
      resumeAt: new Date().toISOString(),
    };
    const failure = buildPreflightFailureState(baseState, error);
    db.savePlanningState(failure.state);
    emitPlanningState(failure.state);
    // 用户可见可观测性：把 preflight 失败原因打到主进程 console，
    // 避免「继续规划还是报错但日志全无」的报告。err 已通过
    // buildPreflightFailureState 内部 redactSensitiveMessage 处理过；
    // 这里再 raw 输出原 error 一次以方便 grep 调用栈。
    logWarn(`[planning] preflight.failure localProductId=${localProductId} existingStatus=${existing?.status ?? "none"} message=${(error as { message?: string } | null)?.message ?? "unknown"}`);
    logWarn(`[planning] preflight.failure stack`, error);
    if (product) {
      db.addMessage(localProductId, "assistant", failure.assistantReply, "failed");
      syncProductStatusAfterFailure(db, localProductId);
      context.emitProduct(db.getProduct(localProductId)!);
    }
    return {
      state: failure.state,
      status: "failed",
      accepted: [],
      rejected: [],
      researchTasks: [],
      assistantReply: failure.assistantReply,
    };
  };
}