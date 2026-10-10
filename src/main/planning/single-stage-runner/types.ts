/**
 * 单阶段执行器的对外契约：
 *   - SingleStageResult：runSingleStage 的返回类型；
 *   - RunSingleStageArgs：runSingleStage 的入参类型。
 *
 * 子文件按"职责"拆：本文件只放"形状"。
 */

import type {
  ModuleOutcome,
  Planner,
  PlanningGenerationState,
  PlanningSkeleton,
  PlanningStage,
  ResearchTaskProposal,
} from "../../../shared/contracts-planning.js";
import type { OrchestratorRuntime } from "../types.js";

export interface SingleStageResult {
  state: PlanningGenerationState;
  accepted: ModuleOutcome[];
  rejected: ModuleOutcome[];
  researchTasks: ResearchTaskProposal[];
  status: "running" | "needs_user" | "completed" | "failed";
  assistantReply: string;
}

export interface RunSingleStageArgs {
  stage: PlanningStage;
  state: PlanningGenerationState;
  skeleton: PlanningSkeleton;
  planner: Planner;
  runtime: OrchestratorRuntime;
  retryLimit: number;
  history: Array<{ role: "user" | "assistant"; content: string }>;
  existingTasks: Array<Pick<ResearchTaskProposal, "label" | "type">>;
  providerLabel?: string;
}