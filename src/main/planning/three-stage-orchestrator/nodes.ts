/**
 * three-stage-orchestrator/nodes：单节点 / 单阶段的执行函数。
 *   - runCompletionAiNode：copy / presentation / commercial 三个 AI 节点的统一驱动（写入 + 校验）；
 *   - completionNodeMissingFields：completion 节点写完后实际产品字段是否落库；
 *   - runResourceNode：cover / vehicleResource 资源查询节点（串行轮询）；
 *   - runLegacyStage：把基础 / 商业 / 文案映射到 runSingleStage 协议。
 *
 * 关键约束：
 *   - cover 与 vehicleResource 共享同一个 VBK BrowserView，必须串行；
 *   - 资源节点每次 attempt 先 assertVbkLogin，失败 → blocked；
 *   - stage.attempts 必须在每个 attempt 边界递增，避免 planner 重入时丢失进度。
 */

import { PLANNING_STAGE_RETRY_LIMIT, type PlanningGenerationState, type PlanningNodeId, type PlanningNodeState, type PlanningPlanV2 } from "../../../shared/contracts-planning.js";
import { runSingleStage } from "../timed-stage-runner.js";
import { asRecord, errorMessage, node } from "./helpers.js";
import type { ThreeStageOrchestratorDependencies } from "./types.js";

type PatchNodeFn = (id: PlanningNodeId, patch: Partial<PlanningNodeState>) => Promise<void>;

export async function runCompletionAiNode(
  deps: ThreeStageOrchestratorDependencies,
  plan: PlanningPlanV2,
  id: "copy" | "presentation" | "commercial",
  stage: "basicInfo" | "presentation" | "commercial",
  patchNode: PatchNodeFn,
): Promise<boolean> {
  await patchNode(id, { status: "running", startedAt: new Date().toISOString(), error: undefined });
  const result = await runLegacyStage(deps, stage, node(plan, id).attempts);
  if (result.status === "completed") {
    const product = await deps.runtime.loadCurrentProduct(deps.localProductId);
    const missing = completionNodeMissingFields(stage, product);
    if (missing.length > 0) {
      await patchNode(id, {
        status: "failed",
        attempts: result.attempts,
        error: `${stage} 节点虽返回成功，但实际产品字段未落库：${missing.join("、")}`,
      });
      return false;
    }
    await patchNode(id, { status: "completed", attempts: result.attempts, summary: stageSummary(stage), completedAt: new Date().toISOString() });
    return true;
  } else {
    await patchNode(id, { status: "failed", attempts: result.attempts, error: result.error });
    return false;
  }
}

function stageSummary(stage: string): string {
  if (stage === "basicInfo") return "副标题与 Operation Notes 已生成";
  if (stage === "presentation") return "推荐语、3 条推荐理由、分类与卖点已生成";
  return "套餐名、价格、库存与草稿 Release 已生成";
}

export function completionNodeMissingFields(
  stage: "basicInfo" | "presentation" | "commercial",
  product: Record<string, unknown>,
): string[] {
  if (stage === "basicInfo") {
    const basic = asRecord(product.basicInfo);
    return ["subtitle", "province", "destinationCity", "operationNotes"]
      .filter((field) => !text(asRecord(basic)?.[field]));
  }
  if (stage === "presentation") {
    const presentation = asRecord(product.presentation);
    return ["recommendation", "recommendations", "features"]
      .filter((field) => {
        const value = asRecord(presentation)?.[field];
        return field === "recommendations" ? !Array.isArray(value) || value.length !== 3 : !text(value);
      });
  }
  const commercial = asRecord(product.commercial);
  return ["packageName", "pricing", "inventory", "release"]
    .filter((field) => {
      const value = asRecord(commercial)?.[field];
      return field === "packageName" ? !text(value) : !asRecord(value);
    });
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export async function runResourceNode(
  deps: ThreeStageOrchestratorDependencies,
  plan: PlanningPlanV2,
  id: "cover" | "vehicleResource",
  patchNode: PatchNodeFn,
  resolve: () => Promise<{ complete: boolean; summary: string }>,
): Promise<void> {
  let attempts = node(plan, id).attempts;
  for (let attempt = attempts + 1; attempt <= PLANNING_STAGE_RETRY_LIMIT; attempt += 1) {
    try {
      await deps.assertVbkLogin();
    } catch (error) {
      await patchNode(id, { status: "blocked", attempts, error: errorMessage(error) });
      return;
    }
    attempts = attempt;
    await patchNode(id, { status: "running", attempts, error: undefined, startedAt: new Date().toISOString() });
    try {
      const outcome = await resolve();
      if (!outcome.complete) throw new Error(outcome.summary);
      await patchNode(id, { status: "completed", attempts, summary: outcome.summary, completedAt: new Date().toISOString() });
      return;
    } catch (error) {
      await patchNode(id, { status: "failed", attempts, error: errorMessage(error) });
    }
  }
}

export async function runLegacyStage(
  deps: ThreeStageOrchestratorDependencies,
  stage: "skeleton" | "basicInfo" | "presentation" | "commercial",
  existingAttempts: number,
): Promise<{ status: string; attempts: number; error: string }> {
  if (existingAttempts >= PLANNING_STAGE_RETRY_LIMIT) {
    return { status: "needs_user", attempts: existingAttempts, error: `${stage} 已达到 3 次尝试上限` };
  }
  const state: PlanningGenerationState = {
    localProductId: deps.localProductId,
    currentStage: stage,
    completedStages: [],
    stages: [],
    status: "running",
    resumeAt: new Date().toISOString(),
    providerLabel: deps.providerLabel,
  };
  const result = await runSingleStage({
    stage,
    state,
    skeleton: deps.skeleton,
    planner: deps.planner,
    runtime: deps.runtime,
    retryLimit: stage === "skeleton" ? 1 : PLANNING_STAGE_RETRY_LIMIT - existingAttempts,
    history: await deps.runtime.loadHistory(deps.localProductId),
    existingTasks: await deps.runtime.loadExistingResearchTasks(deps.localProductId),
    providerLabel: deps.providerLabel,
  });
  const persisted = result.state.stages.find((entry) => entry.stage === stage);
  return {
    status: result.status,
    attempts: stage === "skeleton" ? Math.max(1, existingAttempts) : existingAttempts + (persisted?.attempts ?? 0),
    error: persisted?.lastError?.message || result.rejected.map((entry) => entry.reason).filter(Boolean).join("；") || `${stage} 未通过准入`,
  };
}