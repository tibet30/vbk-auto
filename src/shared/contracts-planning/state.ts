/**
 * 持久化：生成状态按 local_product_id 单行存储；用于「中途重启后从失败阶段续跑」。
 *
 * ModulePersistedState / StagePersistedState 是 stage 完成后写盘的快照；
 * PlanningGenerationState 聚合所有 stage 状态 + 整体 status。
 */

import type { PlanningStage } from "./stages.js";
import type { PlanningModule, ModuleStatus, ModuleOutcome, ResearchTaskProposal } from "./modules.js";
import type { PlanningStageError } from "./output.js";

export interface ModulePersistedState {
  module: PlanningModule;
  status: ModuleStatus;
  reason?: string;
  /** 真正写入的固定路径。AI 不允许自由路径。 */
  writePath?: string;
  acceptedFields?: string[];
  missingFields?: string[];
  /** 模块写入或失败时的 ISO timestamp。 */
  updatedAt: string;
}

export interface StagePersistedState {
  stage: PlanningStage;
  /** 已接受并写入成功的模块集合。 */
  accepted: ModulePersistedState[];
  /** 失败 / 拒绝的模块；用于 UI 显示「缺失 / 被拒」。 */
  rejected: ModulePersistedState[];
  /** 该阶段累计尝试次数；超过 retry-limit 时进入 needs_user。 */
  attempts: number;
  /** 阶段最近一次失败原因。 */
  lastError?: PlanningStageError;
  /** 阶段最近一次成功时间。 */
  updatedAt: string;
}

export interface PlanningGenerationState {
  localProductId: string;
  /** 当前正在运行或下一个要跑的阶段。 */
  currentStage: PlanningStage;
  /** 已完成阶段；这些阶段不会被重跑。 */
  completedStages: PlanningStage[];
  /** 各阶段状态（按 stage 索引）。 */
  stages: StagePersistedState[];
  /** 上次成功的 AI 回复（结构化），用于 UI 显示「已接受」。 */
  lastAssistantReply?: string;
  /** 上次结构化输出的 module 摘要，方便 UI 直接读。 */
  lastModuleSummary?: ModuleOutcome[];
  /** 上次结构化输出的「缺失模块」摘要，方便系统回复用户。 */
  lastMissingSummary?: string[];
  /** 整体状态：pending → running → needs_user | completed | failed */
  status: "pending" | "running" | "needs_user" | "completed" | "failed";
  /** 续跑锚点：上次完成到哪个 stage。重启后 orchestrator 从 currentStage 开始。 */
  resumeAt: string;
  /** Provider 标签：仅用于日志和 UI 显示「上一轮跑的是哪个 provider」；
   *  prompt / schema / validator 永远不允许依赖这个值。 */
  providerLabel?: string;
}

// 仅为了让 reader 一眼看清这是 re-export 链。
export type { ResearchTaskProposal } from "./modules.js";