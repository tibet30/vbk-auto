/**
 * 操作日志 (operation_log) 真实持久化 + 上限 1000 行。
 *
 *   - 写入入口 appendOperationLog：在同一事务里完成 INSERT + COUNT 检查 + 超限 DELETE；
 *   - 查询 queryOperationLog：status/type/stage/projectId/query(全文) + limit；
 *   - recoverOrphanOperationLog：启动时把 status=running 的孤儿条目置为 failed。
 *
 * 历史版返回内存 SAMPLE，V0 起统一写 SQLite。
 */

import type Database from "better-sqlite3";
import type { OperationLogQuery, OperationStatus, OperationType } from "../../../../shared/contracts.js";
import { now } from "./types.js";

/** 操作日志默认上限：超过则按时间最早删。 */
export const OPERATION_LOG_CAP = 1000;

/** SQLite 行 → 上层使用的对象形态。 */
export interface OperationLogRow {
  id: string;
  projectId: string | null;
  projectName: string | null;
  stage: string | null;
  phase: string | null;
  type: string;
  name: string;
  status: string;
  attempt: number;
  startedAt: string;
  durationMs: number;
  target: string | null;
  message: string | null;
  payloadJson: string;
}

/**
 * 写入一条操作日志。内部在同一事务里完成：
 *   1. INSERT；
 *   2. SELECT COUNT 检查上限；
 *   3. 超限时按 started_at 升序 DELETE 超出条目。
 * 失败抛错（让上层 catch 后决定是否重试 / 记 warning）。
 */
export function appendOperationLog(
  db: Database.Database,
  entry: Record<string, unknown> & { id: string; type: string; name: string; status: string; startedAt: string },
): void {
  const insert = db.prepare(`
    INSERT INTO operation_log (
      id, project_id, project_name, stage, phase, type, name, status,
      attempt, started_at, duration_ms, target, message, payload_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const count = db.prepare(`SELECT COUNT(*) AS n FROM operation_log`).get() as { n: number };
  const tx = db.transaction(() => {
    insert.run(
      entry.id,
      (entry.projectId as string | null) ?? null,
      (entry.projectName as string | null) ?? null,
      (entry.stage as string | null) ?? null,
      (entry.phase as string | null) ?? null,
      entry.type,
      entry.name,
      entry.status,
      Number(entry.attempt ?? 1) || 1,
      entry.startedAt,
      Number(entry.durationMs ?? 0) || 0,
      (entry.target as string | null) ?? null,
      (entry.message as string | null) ?? null,
      JSON.stringify((entry.payload as Record<string, unknown> | null) ?? {}),
    );
    const totalAfter = count.n + 1;
    if (totalAfter > OPERATION_LOG_CAP) {
      const overflow = totalAfter - OPERATION_LOG_CAP;
      db.prepare(`
        DELETE FROM operation_log WHERE id IN (
          SELECT id FROM operation_log ORDER BY started_at ASC LIMIT ?
        )
      `).run(overflow);
    }
  });
  tx();
}

/** 测试 / 清理用：返回当前操作日志行数。 */
export function countOperationLog(db: Database.Database): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM operation_log`).get() as { n: number };
  return row.n;
}

/**
 * 查询操作日志。查询语义保持与 operation-log-store.ts 中旧 matchQuery 一致。
 * 入参 query 的字段：status / type / stage / projectId / query（全文 / 模糊）。
 * 返回行按 started_at DESC 排序。
 */
export function queryOperationLog(
  db: Database.Database,
  query: {
    status?: OperationStatus | "all";
    type?: OperationType | "all";
    stage?: string;
    projectId?: string;
    query?: string;
    limit?: number;
  },
): Array<OperationLogRow> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (query.status && query.status !== "all") {
    where.push("status = ?");
    params.push(query.status);
  }
  if (query.type && query.type !== "all") {
    where.push("type = ?");
    params.push(query.type);
  }
  if (query.stage && query.stage !== "all") {
    where.push("stage = ?");
    params.push(query.stage);
  }
  if (query.projectId) {
    where.push("project_id = ?");
    params.push(query.projectId);
  }
  if (query.query && query.query.trim()) {
    const needle = `%${query.query.trim()}%`;
    where.push(
      "(name LIKE ? OR target LIKE ? OR message LIKE ? OR stage LIKE ? OR phase LIKE ? OR project_name LIKE ?)",
    );
    params.push(needle, needle, needle, needle, needle, needle);
  }
  const sql = `
    SELECT id, project_id AS projectId, project_name AS projectName,
      stage, phase, type, name, status,
      attempt, started_at AS startedAt, duration_ms AS durationMs,
      target, message, payload_json AS payloadJson
    FROM operation_log
    ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY started_at DESC
    LIMIT ?
  `;
  const limit = query.limit && query.limit > 0 ? Math.min(query.limit, OPERATION_LOG_CAP) : OPERATION_LOG_CAP;
  params.push(limit);
  return db.prepare(sql).all(...params) as Array<OperationLogRow>;
}

/**
 * 启动时把 operation_log 里 status=running 的孤儿条目置为 failed。
 * 与 recoverOrphanAutomationRuns 语义对等：数据库进程意外退出时，
 * 自动化阶段被中断但 operation_log 仍可能存在 stale 'running' 条目。
 */
export function recoverOrphanOperationLog(db: Database.Database): number {
  const stmt = db.prepare(`
    UPDATE operation_log SET status='failed', message=COALESCE(message, '') || ' (应用重启)'
    WHERE status='running'
  `);
  const info = stmt.run();
  return info.changes;
}

/** 把 OperationLogQuery 转成内部查询结构，保留空值过滤。 */
export function normaliseOperationLogQuery(query?: OperationLogQuery) {
  if (!query) return { limit: OPERATION_LOG_CAP } as const;
  const limit = query.limit ?? OPERATION_LOG_CAP;
  return { ...query, limit: Math.max(1, Math.min(limit, OPERATION_LOG_CAP)) };
}
