/**
 * three-stage-orchestrator/plan-factory：
 *   - createPlanningPlanV2：新建一份空白 plan（按 NODE_DEFINITIONS 顺序生成节点）；
 *   - normalisePlan：兼容旧 plan（version !== 2 时替换为新 plan；同 id 的节点沿用旧状态）。
 */

import { randomUUID } from "node:crypto";
import type { PlanningPlanV2 } from "../../../shared/contracts-planning.js";
import { NODE_DEFINITIONS } from "./types.js";

export function createPlanningPlanV2(now = new Date().toISOString()): PlanningPlanV2 {
  return {
    version: 2,
    runId: randomUUID(),
    status: "pending",
    currentNode: "skeleton",
    nodes: NODE_DEFINITIONS.map(([id, majorStage]) => ({ id, majorStage, status: "pending", attempts: 0 })),
    poiCandidates: [],
    createdAt: now,
    updatedAt: now,
  };
}

export function normalisePlan(plan?: PlanningPlanV2): PlanningPlanV2 {
  if (!plan || plan.version !== 2) return createPlanningPlanV2();
  const byId = new Map(plan.nodes.map((entry) => [entry.id, entry]));
  return {
    ...plan,
    nodes: NODE_DEFINITIONS.map(([id, majorStage]) => byId.get(id) ?? { id, majorStage, status: "pending", attempts: 0 }),
    poiCandidates: Array.isArray(plan.poiCandidates) ? plan.poiCandidates : [],
  };
}