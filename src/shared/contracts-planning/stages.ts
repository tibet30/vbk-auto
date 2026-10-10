/**
 * Planning 阶段 / 节点契约。
 *
 * 与 orchestrator 解耦，只描述类型；运行时值（如 PLANNING_STAGES /
 * PLANNING_STAGE_RETRY_LIMIT）也放在这里以便 UI / 测试共用同一份真理源。
 */

import type { ResearchTaskProposal } from "./modules.js";

/**
 * 每一轮规划都按顺序经过 5 个阶段；任一阶段失败可单独重跑，已通过阶段的
 * 结果会持久化下来用于续跑。
 */
export type PlanningStage =
  | "skeleton"
  | "basicInfo"
  | "itinerary"
  | "presentation"
  | "commercial"
  | "research"
  | "validation";

export const PLANNING_STAGES: readonly PlanningStage[] = [
  "skeleton",
  "basicInfo",
  "itinerary",
  "presentation",
  "commercial",
  "research",
  "validation",
] as const;

/**
 * 默认每阶段最多重试次数（含首跑）；超过后会进入 needs_user。
 * 与 adapter 的 maxAttempts=1 组合后，单个 AI 阶段在合理情况下的
 * planner 调用上限 = retryLimit（≤ 3）。
 */
export const PLANNING_STAGE_RETRY_LIMIT = 3;

export type PlanningMajorStage = "foundation" | "itinerary" | "completion";
export type PlanningNodeId =
  | "skeleton"
  | "spotCandidates"
  | "poiResolution"
  | "itineraryDraft"
  | "hotelResolution"
  | "copy"
  | "presentation"
  | "commercial"
  | "cover"
  | "vehicleResource"
  | "finalValidation";

export type PlanningNodeStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "blocked"
  | "skipped"
  | "invalidated";

export interface PlanningNodeState {
  id: PlanningNodeId;
  majorStage: PlanningMajorStage;
  status: PlanningNodeStatus;
  attempts: number;
  summary?: string;
  error?: string;
  startedAt?: string;
  completedAt?: string;
}

export type ItineraryAdoptionStatus = "pending" | "verifying" | "accepted" | "blocked";

/**
 * 行程由对话 patch 产生后，必须先由运营显式采用；completion 不能继续沿用
 * 旧行程生成的派生数据。这个信号与 PlanningPlanV2 一起落到 Tibet。
 */
export interface ItineraryAdoptionState {
  status: ItineraryAdoptionStatus;
  itineraryRevision: string;
  triggeredAt: string;
  /** 本轮用户消息中明确点名的景点；未命中 POI 时允许保留给运营手动处理。 */
  userRecommendedSpotNames?: string[];
  error?: string;
}

// 仅为共享模块类型用：研究任务方案（research 模块产出）。
export type { ResearchTaskProposal } from "./modules.js";