/**
 * VbkDatabase 工作流任务 + Agent snapshot + planning state 部分：
 *   - createWorkflowTask / completeWorkflowTaskForProduct /
 *     completeSavedProductWorkflowTasks /
 *     reconcileSupersededWorkflowTasks / getWorkflowTask /
 *     latestWorkflowTaskForProduct / listWorkflowTasks /
 *     abandonWorkflowTask / updateWorkflowTask /
 *     recoverOrphanWorkflowTasks
 *   - getAgentSnapshot / saveAgentSnapshot
 *   - loadPlanningState / savePlanningState / deletePlanningState /
 *     recoverOrphanPlanningStates
 *
 * 实现策略：方法集合对象；database.ts 用 Object.assign 合并到 VbkDatabase。
 */

import type {
  AgentSnapshot,
  PlanningGenerationState,
  ProductSummary,
  ProductWorkflowTask,
} from "../../../../shared/contracts.js";
import type Database from "better-sqlite3";
import { getAgentSnapshot, saveAgentSnapshot } from "../parts/agent.js";
import { deletePlanningState, loadPlanningState, recoverOrphanPlanningStates, savePlanningState } from "../parts/planning-state.js";
import {
  abandonWorkflowTask,
  completeSavedProductWorkflowTasks,
  completeWorkflowTaskForProduct,
  createWorkflowTask,
  getWorkflowTask,
  latestWorkflowTaskForProduct,
  listWorkflowTasks,
  recoverOrphanWorkflowTasks,
  reconcileSupersededWorkflowTasks,
  updateWorkflowTask,
} from "../parts/workflow-tasks.js";

export const agentMethods = {
  // ─────────────────────────────────────────────────────────────────────
  // workflow_tasks
  // ─────────────────────────────────────────────────────────────────────
  createWorkflowTask(this: { db: Database.Database }, localProductId: string, productName: string): ProductWorkflowTask { return createWorkflowTask(this.db, localProductId, productName); },
  completeWorkflowTaskForProduct(this: { db: Database.Database }, product: Pick<ProductSummary, "id" | "status" | "productId">): ProductWorkflowTask | undefined { return completeWorkflowTaskForProduct(this.db, product); },
  completeSavedProductWorkflowTasks(this: { db: Database.Database }): ProductWorkflowTask[] { return completeSavedProductWorkflowTasks(this.db); },
  reconcileSupersededWorkflowTasks(this: { db: Database.Database }): ProductWorkflowTask[] { return reconcileSupersededWorkflowTasks(this.db); },
  getWorkflowTask(this: { db: Database.Database }, id: string): ProductWorkflowTask | undefined { return getWorkflowTask(this.db, id); },
  latestWorkflowTaskForProduct(this: { db: Database.Database }, localProductId: string): ProductWorkflowTask | undefined { return latestWorkflowTaskForProduct(this.db, localProductId); },
  listWorkflowTasks(this: { db: Database.Database }): ProductWorkflowTask[] { return listWorkflowTasks(this.db); },
  abandonWorkflowTask(this: { db: Database.Database }, id: string): ProductWorkflowTask { return abandonWorkflowTask(this.db, id); },
  updateWorkflowTask(this: { db: Database.Database }, id: string, patch: Parameters<typeof updateWorkflowTask>[2]): ProductWorkflowTask { return updateWorkflowTask(this.db, id, patch); },
  recoverOrphanWorkflowTasks(this: { db: Database.Database }): ProductWorkflowTask[] { return recoverOrphanWorkflowTasks(this.db); },

  // ─────────────────────────────────────────────────────────────────────
  // planning_generation
  // ─────────────────────────────────────────────────────────────────────
  loadPlanningState(this: { db: Database.Database }, localProductId: string): PlanningGenerationState | undefined { return loadPlanningState(this.db, localProductId); },
  savePlanningState(this: { db: Database.Database }, state: PlanningGenerationState): void { savePlanningState(this.db, state); },
  deletePlanningState(this: { db: Database.Database }, localProductId: string): void { deletePlanningState(this.db, localProductId); },
  recoverOrphanPlanningStates(this: { db: Database.Database }): string[] { return recoverOrphanPlanningStates(this.db); },

  // ─────────────────────────────────────────────────────────────────────
  // agent_snapshots
  // ─────────────────────────────────────────────────────────────────────
  getAgentSnapshot(this: { db: Database.Database }, localProductId: string): AgentSnapshot | undefined { return getAgentSnapshot(this.db, localProductId); },
  saveAgentSnapshot(this: { db: Database.Database; executionClock: { setEnabled: (localProductId: string, enabled: boolean, source: string) => void } }, snapshot: AgentSnapshot): void {
    saveAgentSnapshot(this.db, snapshot);
    this.executionClock.setEnabled(snapshot.localProductId, snapshot.run?.status === "running", "agent");
  },
} as const;