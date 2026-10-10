/**
 * 单阶段执行器的总入口：
 *   - runSingleStage：按 stage 派发到 skeleton / validation / research / ai；
 *   - 准备 stageAllowed + accepted/rejected/researchTasks 初始集合；
 *   - 委托给具体 stage 子函数（见 ./types.js）。
 */

import { STAGE_ALLOWED_MODULES } from "../stage-contract.js";
import { logStageStart } from "../log.js";
import type {
  ModuleOutcome,
  Planner,
  PlanningGenerationState,
  PlanningModule,
  PlanningSkeleton,
  PlanningStage,
  PlanningStageError,
  ResearchTaskProposal,
} from "../../../shared/contracts-planning.js";
import type { OrchestratorRuntime } from "../types.js";
import { runAiStage } from "./ai-stage.js";
import {
  runResearchStage,
  runSkeletonStage,
  runValidationStage,
} from "./skeleton-validation-research.js";
import type { RunSingleStageArgs, SingleStageResult } from "./types.js";

export async function runSingleStage(args: RunSingleStageArgs): Promise<SingleStageResult> {
  const { stage, state, skeleton, planner, runtime, retryLimit, history, existingTasks } = args;
  const allowed = STAGE_ALLOWED_MODULES[stage] as readonly PlanningModule[];
  const accepted: ModuleOutcome[] = [];
  const rejected: ModuleOutcome[] = [];
  const researchTasks: ResearchTaskProposal[] = [];
  let attempts = state.stages.find((s) => s.stage === stage)?.attempts ?? 0;
  let lastError: PlanningStageError | undefined;
  logStageStart("进入阶段", { stage, localProductId: state.localProductId, attempts });

  if (stage === "skeleton") {
    return await runSkeletonStage({ state, skeleton, runtime, attempts, lastError });
  }

  if (stage === "validation") {
    return await runValidationStage({ state, skeleton, runtime, attempts, lastError });
  }

  if (stage === "research") {
    return await runResearchStage({ state, skeleton, runtime, existingTasks, attempts, lastError });
  }

  return await runAiStage({
    stage, state, skeleton, planner, runtime, retryLimit, history, existingTasks, providerLabel: args.providerLabel,
    allowed, accepted, rejected, researchTasks, attempts, lastError,
  });
}