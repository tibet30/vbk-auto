/**
 * 单阶段执行器的结果组装：
 *   - makeStageResult：合并 accepted / rejected / status / currentStage 校正；
 *   - normaliseStageOutcomes：commercial 阶段交给 normaliseCommercialOutcomes 处理；
 *   - now()：统一 ISO8601 时间戳。
 */

import { composeStageAssistantReply } from "../replies.js";
import { upsertStageInState } from "../stage-runner.js";
import type {
  ModuleOutcome,
  PlanningGenerationState,
  PlanningStage,
  PlanningStageError,
} from "../../../shared/contracts-planning.js";
import { normaliseCommercialOutcomes } from "../commercial-stage.js";
import type { SingleStageResult } from "./types.js";

interface MakeStageResultArgs {
  state: PlanningGenerationState;
  stage: PlanningStage;
  accepted: ModuleOutcome[];
  rejected: ModuleOutcome[];
  researchTasks: import("../../../shared/contracts-planning.js").ResearchTaskProposal[];
  attempts: number;
  lastError: PlanningStageError | undefined;
  status: "running" | "needs_user" | "completed" | "failed";
}

/**
 * 组装阶段结果：
 *   - 修正 currentStage：上一轮残留的 currentStage 与本轮失败 stage 不一致时校正；
 *   - 写回 accepted / rejected / attempts / lastError / status；
 *   - 用 composeStageAssistantReply 生成给用户的中文 assistant 文案。
 */
export function makeStageResult(args: MakeStageResultArgs): SingleStageResult {
  const outcomes = normaliseStageOutcomes(args.stage, args.accepted, args.rejected);
  // currentStage 保留失败 stage（让用户看到「卡在哪」）；resume 由
  // plan-orchestrator 的 skip 逻辑跳过已完成的 stage，从 currentStage 起跑。
  // 只在 needs_user / failed 时把 currentStage 校正为本次失败的 stage，
  // 防止上一轮 needs_user 留下的 currentStage 与本次失败的 stage 不一致
  // 导致用户看到「currentStage=skeleton 但实际跑的是 itinerary」的怪现象。
  const currentStage = args.state.currentStage === args.stage || args.state.completedStages.includes(args.state.currentStage)
    ? args.state.currentStage
    : args.stage;
  const stateAfter = {
    ...args.state,
    status: args.status,
    currentStage,
    stages: upsertStageInState(args.state, args.stage, {
      accepted: outcomes.accepted,
      rejected: outcomes.rejected,
      attempts: args.attempts,
      lastError: args.lastError,
      updatedAt: now(),
    }),
  };
  return {
    state: stateAfter,
    accepted: outcomes.accepted,
    rejected: outcomes.rejected,
    researchTasks: args.researchTasks,
    status: args.status,
    assistantReply: composeStageAssistantReply(args.stage, outcomes.accepted, outcomes.rejected),
  };
}

function normaliseStageOutcomes(
  stage: PlanningStage,
  accepted: ModuleOutcome[],
  rejected: ModuleOutcome[],
): { accepted: ModuleOutcome[]; rejected: ModuleOutcome[] } {
  if (stage !== "commercial") return { accepted, rejected };
  return normaliseCommercialOutcomes(accepted, rejected);
}

/** 统一时间戳（ISO8601 字符串）；用于 persistence 与日志。 */
export function now(): string {
  return new Date().toISOString();
}