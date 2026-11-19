/**
 * 阶段输出 / 错误契约。
 *
 * 每个阶段只允许返回 PlanningStageOutput；AI 不能写 RFC6902 patch。失败时抛
 * PlannerError，orchestrator 根据 code 决定是否重试。
 */

import type { PlanningStage } from "./stages.js";
import type { ModuleOutcome, PlanningModule } from "./modules.js";
import type { PlanningGenerationState } from "./state.js";

export interface PlanningStageOutput {
  /** 给运营的中文回复，简短说明本阶段结果。 */
  reply: string;
  /** 本阶段产出的模块；可能是空（全部失败）或部分。 */
  modules: ModuleOutcome[];
  /** 阶段级问题（最多 1 条），仅当完全阻塞下一阶段才返回。 */
  question?: string;
}

export interface PlanningRunResult {
  state: PlanningGenerationState;
  status: "completed" | "needs_user" | "failed";
  accepted: PlanningModule[];
  rejected: Array<{ module: PlanningModule; reason?: string }>;
  researchTasks: Array<{ label: string; type: "vbk" | "web" | "cost" | "image"; detail?: string }>;
  assistantReply: string;
}

export interface PlanningStageError {
  stage: PlanningStage;
  attempt: number;
  message: string;
  code: string;
  /** 失败原因细节（保留以便 UI 显示），但绝不持久化为产品字段。 */
  details?: string;
}