/**
 * 记忆只读入口：list / get / by-topic / maintenance state 读取。
 *
 * 写入 / 删除见 ./write.ts；状态写入见 ./state.ts。
 */

import type Database from "better-sqlite3";
import type { MemoryFilter, UserMemory } from "../../../../../shared/contracts.js";
import { toUserMemory, type MaintenanceRow, type MemoryRow } from "./types.js";
import { now } from "../types.js";

export function listUserMemories(
  db: Database.Database,
  ownerUserId: number,
  filter: MemoryFilter,
): UserMemory[] {
  const limit = Math.min(filter.limit ?? 20, 200);
  const offset = Math.max(filter.offset ?? 0, 0);
  const includeInactive = filter.includeInactive ?? false;
  const where: string[] = ["owner_user_id=?"];
  const values: unknown[] = [ownerUserId];

  if (filter.scopeType) {
    where.push("scope_type=?");
    values.push(filter.scopeType);
  }
  if (filter.scopeKey !== undefined) {
    where.push("scope_key=?");
    values.push(filter.scopeKey);
  }

  if (!includeInactive) {
    where.push("status IN ('active','pending')");
  } else if (filter.status?.length) {
    const placeholders = filter.status.map(() => "?").join(",");
    where.push(`status IN (${placeholders})`);
    values.push(...filter.status);
  }

  const orderBy = filter.order === "evidence"
    ? "ORDER BY last_evidence_at DESC, updated_at DESC"
    : "ORDER BY updated_at DESC, id DESC";

  const rows = db.prepare(`
    SELECT * FROM user_memories
    WHERE ${where.join(" AND ")}
    ${orderBy}
    LIMIT ? OFFSET ?
  `).all(...values, limit, offset) as MemoryRow[];

  return rows.map((row) => toUserMemory(row));
}

export function getUserMemory(db: Database.Database, ownerUserId: number, id: string): UserMemory | undefined {
  const row = db.prepare("SELECT * FROM user_memories WHERE owner_user_id=? AND id=?").get(ownerUserId, id) as MemoryRow | undefined;
  return row ? toUserMemory(row) : undefined;
}

export function getMemoryByTopic(
  db: Database.Database,
  ownerUserId: number,
  topic: string,
): UserMemory[] {
  return db.prepare("SELECT * FROM user_memories WHERE owner_user_id=? AND topic=?")
    .all(ownerUserId, topic)
    .map((row) => toUserMemory(row as MemoryRow));
}

export function getMemoryMaintenanceState(
  db: Database.Database,
  ownerUserId: number,
): {
  ownerUserId: number;
  autoCapture: boolean;
  scopeKey: string | null;
  lastTaskId: string | null;
  pendingCount: number;
  lastSuccessAt: string | null;
  updatedAt: string;
} {
  const fallback = {
    ownerUserId,
    autoCapture: true,
    scopeKey: null,
    lastTaskId: null,
    pendingCount: 0,
    lastSuccessAt: null,
    updatedAt: now(),
  };

  const row = db.prepare("SELECT * FROM memory_maintenance_state WHERE owner_user_id=?")
    .get(ownerUserId) as MaintenanceRow | undefined;
  if (!row) {
    createMemoryState(db, ownerUserId);
    return fallback;
  }

  return {
    ownerUserId: row.owner_user_id,
    autoCapture: Boolean(row.auto_capture),
    scopeKey: row.scope_key,
    lastTaskId: row.last_task_id,
    pendingCount: row.pending_count,
    lastSuccessAt: row.last_success_at,
    updatedAt: row.updated_at,
  };
}

// Forward declaration to avoid circular import between list.ts and state.ts.
// 实际创建走 ./state.ts 的 createMemoryState。
declare function createMemoryState(db: Database.Database, ownerUserId: number): void;