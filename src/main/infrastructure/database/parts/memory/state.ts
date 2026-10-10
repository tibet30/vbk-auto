/**
 * 记忆维护状态写：
 *   - createMemoryState：upsert 默认行（auto_capture=1, pending_count=0）；
 *   - bumpMemoryMaintenanceCursor：自增 pending_count + 更新 last_task_id；
 *   - clearMemoryMaintenancePending：清 pending + 设 last_success_at；
 *   - createOrUpdateMemoryState：部分字段更新（不重置未指定的字段）；
 *   - markMemorySuccess：调用 createOrUpdateMemoryState 清 pending + 记 last_success_at。
 *
 * 读操作（getMemoryMaintenanceState）见 ./list.ts。
 */

import type Database from "better-sqlite3";
import { now } from "../types.js";
import type { MaintenanceRow } from "./types.js";

export function createMemoryState(db: Database.Database, ownerUserId: number): void {
  const timestamp = now();
  db.prepare(
    "INSERT INTO memory_maintenance_state(owner_user_id, auto_capture, pending_count, updated_at) VALUES(?,?,?,?) " +
    "ON CONFLICT(owner_user_id) DO UPDATE SET updated_at=excluded.updated_at",
  ).run(ownerUserId, 1, 0, timestamp);
}

export function bumpMemoryMaintenanceCursor(
  db: Database.Database,
  ownerUserId: number,
  cursorTaskId?: string,
): void {
  const updatedAt = now();
  db.prepare(
    "INSERT INTO memory_maintenance_state(owner_user_id, auto_capture, last_task_id, last_success_at, updated_at, pending_count) " +
      "VALUES(?,?,?,?,?,COALESCE((SELECT pending_count FROM memory_maintenance_state WHERE owner_user_id=?),0)+1) " +
      "ON CONFLICT(owner_user_id) DO UPDATE SET last_task_id=COALESCE(excluded.last_task_id, memory_maintenance_state.last_task_id), " +
      "updated_at=excluded.updated_at, pending_count = memory_maintenance_state.pending_count + 1",
  ).run(ownerUserId, 1, cursorTaskId ?? null, null, updatedAt, ownerUserId);
}

export function clearMemoryMaintenancePending(db: Database.Database, ownerUserId: number): void {
  const updatedAt = now();
  db.prepare(
    "UPDATE memory_maintenance_state SET pending_count=0, last_success_at=?, updated_at=? WHERE owner_user_id=?",
  ).run(updatedAt, updatedAt, ownerUserId);
}

export function createOrUpdateMemoryState(
  db: Database.Database,
  ownerUserId: number,
  patch: Partial<Pick<MaintenanceRow, "auto_capture" | "scope_key" | "last_task_id" | "pending_count" | "last_success_at" | "updated_at">>,
): void {
  // Ensure a row exists with defaults, then UPDATE only fields present in the
  // patch. Omitting auto_capture/pending_count must not reset them to 1/0.
  createMemoryState(db, ownerUserId);
  const sets: string[] = [];
  const values: unknown[] = [];
  if (patch.auto_capture !== undefined) {
    sets.push("auto_capture=?");
    values.push(patch.auto_capture);
  }
  if (patch.scope_key !== undefined) {
    sets.push("scope_key=?");
    values.push(patch.scope_key);
  }
  if (patch.last_task_id !== undefined) {
    sets.push("last_task_id=?");
    values.push(patch.last_task_id);
  }
  if (patch.pending_count !== undefined) {
    sets.push("pending_count=?");
    values.push(patch.pending_count);
  }
  if (patch.last_success_at !== undefined) {
    sets.push("last_success_at=?");
    values.push(patch.last_success_at);
  }
  sets.push("updated_at=?");
  values.push(patch.updated_at ?? now());
  values.push(ownerUserId);
  db.prepare(`UPDATE memory_maintenance_state SET ${sets.join(", ")} WHERE owner_user_id=?`).run(...values);
}

export function markMemorySuccess(db: Database.Database, ownerUserId: number): void {
  createOrUpdateMemoryState(db, ownerUserId, { last_success_at: now(), pending_count: 0 });
}