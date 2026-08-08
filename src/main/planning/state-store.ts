/**
 * 生成状态持久化：每个项目一行 JSON，存于 planning_generation 表。
 *
 * 该模块暴露给 VbkDatabase；orchestrator 通过 GenerationStateStore 接口
 * 读写它，与底层 SQLite 解耦。
 */

import type { PlanningGenerationState } from "../../shared/contracts-planning.js";

export interface PlanningGenerationRow {
  project_id: string;
  state_json: string;
  updated_at: string;
}

export interface PlanningStatePersistence {
  upsertRow(row: PlanningGenerationRow): void;
  selectRow(projectId: string): PlanningGenerationRow | undefined;
}

export class SqlitePlanningStateStore {
  constructor(private readonly db: { prepare: (sql: string) => { run(...args: unknown[]): unknown; get(...args: unknown[]): unknown; all(...args: unknown[]): unknown[] } }) {}

  upsert(state: PlanningGenerationState): void {
    const stmt = this.db.prepare(`
      INSERT INTO planning_generation (project_id, state_json, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(project_id) DO UPDATE SET state_json=excluded.state_json, updated_at=excluded.updated_at
    `);
    stmt.run(state.projectId, JSON.stringify(state), state.resumeAt);
  }

  load(projectId: string): PlanningGenerationState | undefined {
    const row = this.db.prepare(`SELECT state_json FROM planning_generation WHERE project_id=?`).get(projectId) as { state_json: string } | undefined;
    if (!row) return undefined;
    try {
      return JSON.parse(row.state_json) as PlanningGenerationState;
    } catch {
      return undefined;
    }
  }
}

export function ensurePlanningGenerationTable(persistence: PlanningStatePersistence): void {
  // No-op placeholder; the actual CREATE TABLE statement lives in the database
  // migration. Here we only expose the typed upsert helpers.
  void persistence;
}