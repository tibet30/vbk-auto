/**
 * 生成状态持久化：每个产品一行 JSON，存于 planning_generation 表。
 *
 * 该模块暴露给 VbkDatabase；orchestrator 通过 GenerationStateStore 接口
 * 读写它，与底层 SQLite 解耦。
 */

import type { PlanningGenerationState } from "../../shared/contracts-planning.js";

export interface PlanningGenerationRow {
  local_product_id: string;
  state_json: string;
  updated_at: string;
}

export interface PlanningStatePersistence {
  upsertRow(row: PlanningGenerationRow): void;
  selectRow(localProductId: string): PlanningGenerationRow | undefined;
}

/**
 * SQLite 实现的 PlanningGenerationState 仓库：
 *   - upsert 用 INSERT ... ON CONFLICT 保证每个产品只保留最新一份 state；
 *   - load 反序列化 JSON；解析失败返回 undefined 触发上层重新初始化。
 * 仅依赖基础 better-sqlite3 风格 prepare/run/get 接口，不耦合具体 ORM。
 */
export class SqlitePlanningStateStore {
  constructor(private readonly db: { prepare: (sql: string) => { run(...args: unknown[]): unknown; get(...args: unknown[]): unknown; all(...args: unknown[]): unknown[] } }) {}

  /**
   * 把当前 PlanningGenerationState 持久化到对应 localProductId 行，存在则覆盖。
   */
  upsert(state: PlanningGenerationState): void {
    const stmt = this.db.prepare(`
      INSERT INTO planning_generation (local_product_id, state_json, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(local_product_id) DO UPDATE SET state_json=excluded.state_json, updated_at=excluded.updated_at
    `);
    stmt.run(state.localProductId, JSON.stringify(state), state.resumeAt);
  }

  /**
   * 从规划库加载指定 localProductId 的最新 state；找不到行或 JSON 解析失败均返回 undefined。
   */
  load(localProductId: string): PlanningGenerationState | undefined {
    const row = this.db.prepare(`SELECT state_json FROM planning_generation WHERE local_product_id=?`).get(localProductId) as { state_json: string } | undefined;
    if (!row) return undefined;
    try {
      return JSON.parse(row.state_json) as PlanningGenerationState;
    } catch {
      return undefined;
    }
  }
}

/**
 * 占位函数：建表语句由 database migration 负责执行，本模块只暴露类型化 upsert/load 助手。
 * 调用方在初始化阶段会触发 schema 迁移，这里保留接口以便测试中可注入 mock。
 */
export function ensurePlanningGenerationTable(persistence: PlanningStatePersistence): void {
  // No-op placeholder; the actual CREATE TABLE statement lives in the database
  // migration. Here we only expose the typed upsert helpers.
  void persistence;
}