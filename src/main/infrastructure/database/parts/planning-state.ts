/**
 * 规划状态 (planning_generation) 持久化层：
 *   - loadPlanningState / savePlanningState / deletePlanningState
 *   - recoverOrphanPlanningStates：启动时把 status=running 改成 needs_user
 *
 * 状态以 JSON 字符串整体写入；状态 schema 由上层 planning 模块校验。
 */

import type Database from "better-sqlite3";
import type { PlanningGenerationState } from "../../../../shared/contracts.js";
import { now } from "./types.js";

/**
 * 加载产品的规划生成状态。返回值是完整的 PlanningGenerationState；
 * 表里没有对应行时返回 undefined。
 */
export function loadPlanningState(db: Database.Database, localProductId: string): PlanningGenerationState | undefined {
  const row = db.prepare(`SELECT state_json FROM planning_generation WHERE local_product_id=?`).get(localProductId) as { state_json: string } | undefined;
  if (!row) return undefined;
  try {
    return JSON.parse(row.state_json) as PlanningGenerationState;
  } catch {
    return undefined;
  }
}

/** 覆盖 / 写入规划状态。 */
export function savePlanningState(db: Database.Database, state: PlanningGenerationState): void {
  const updatedAt = new Date().toISOString();
  const payload = JSON.stringify({ ...state, resumeAt: updatedAt });
  const stmt = db.prepare(`
    INSERT INTO planning_generation (local_product_id, state_json, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(local_product_id) DO UPDATE SET state_json=excluded.state_json, updated_at=excluded.updated_at
  `);
  // 单语句写入：即使没有外层事务,这里也是原子单次写入。
  const tx = db.transaction(() => stmt.run(state.localProductId, payload, updatedAt));
  tx();
}

/** 删除产品的规划状态；仅供产品删除时调用。 */
export function deletePlanningState(db: Database.Database, localProductId: string): void {
  db.prepare("DELETE FROM planning_generation WHERE local_product_id=?").run(localProductId);
}

/**
 * 重启后恢复规划状态：
 *   - status=running → needs_user（UI 让运营选择「重跑 / 手动补齐」）；
 *   - status=needs_user / completed / failed → 保持不变。
 * 返回受影响的产品 ID 列表。
 */
export function recoverOrphanPlanningStates(db: Database.Database): string[] {
  const orphans = db.prepare(`
    SELECT local_product_id, state_json FROM planning_generation
  `).all() as Array<{ local_product_id: string; state_json: string }>;
  const touched: string[] = [];
  const upsert = db.prepare(`
    INSERT INTO planning_generation (local_product_id, state_json, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(local_product_id) DO UPDATE SET state_json=excluded.state_json, updated_at=excluded.updated_at
  `);
  for (const row of orphans) {
    try {
      const state = JSON.parse(row.state_json) as { status?: string };
      if (state.status === "running") {
        state.status = "needs_user";
        upsert.run(row.local_product_id, JSON.stringify(state), now());
        touched.push(row.local_product_id);
      }
    } catch { /* leave unreadable legacy state untouched */ }
  }
  return touched;
}
