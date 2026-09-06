/**
 * 本地记忆存储：显式偏好（explicit）与推断偏好（inferred）。
 *
 * 约定：
 * 1) 所有写入都带 owner_user_id（不支持匿名 fallback）。
 * 2) 更新、禁用、删除都带 owner_user_id，避免跨用户误改。
 * 3) SQL 语义尽量集中在这里，避免上层重复拼表。
 */

import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import type {
  MemoryInput,
  MemoryFilter,
  MemoryPatch,
  MemorySaveResult,
  UserMemory,
  UserMemoryEvidence,
  UserMemoryKind,
  UserMemoryScopeType,
  UserMemoryStatus,
} from "../../../../shared/contracts.js";
import { now } from "./types.js";

export interface MemoryRow {
  id: string;
  owner_user_id: number;
  scope_type: UserMemoryScopeType;
  scope_key: string;
  kind: UserMemoryKind;
  topic: string;
  preference_key: string | null;
  content: string;
  conditions_json: string;
  status: UserMemoryStatus;
  revision: number;
  superseded_by: string | null;
  created_at: string;
  updated_at: string;
  last_evidence_at: string | null;
  last_used_at: string | null;
}

export interface MemoryEvidenceRow {
  id: string;
  owner_user_id: number;
  memory_id: string;
  source_event_id: string | null;
  task_id: string | null;
  source_kind: string;
  raw_excerpt: string | null;
  created_at: string;
}

export interface MaintenanceRow {
  owner_user_id: number;
  auto_capture: number;
  scope_key: string | null;
  last_task_id: string | null;
  pending_count: number;
  last_success_at: string | null;
  updated_at: string;
}

function parseConditions(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item) => typeof item === "string")
      .map((item) => item.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function toUserMemory(record: MemoryRow): UserMemory {
  const conditions = parseConditions(record.conditions_json);
  return {
    id: record.id,
    ownerUserId: record.owner_user_id,
    scopeType: record.scope_type,
    scopeKey: record.scope_key,
    kind: record.kind,
    topic: record.topic,
    preferenceKey: record.preference_key ?? undefined,
    content: record.content,
    conditions,
    status: record.status,
    revision: record.revision,
    supersededBy: record.superseded_by ?? undefined,
    createdAt: record.created_at,
    updatedAt: record.updated_at,
    ...(record.last_evidence_at ? { lastEvidenceAt: record.last_evidence_at } : {}),
    ...(record.last_used_at ? { lastUsedAt: record.last_used_at } : {}),
  };
}

export function createMemoryState(db: Database.Database, ownerUserId: number): void {
  const timestamp = now();
  db.prepare(
    "INSERT INTO memory_maintenance_state(owner_user_id, auto_capture, pending_count, updated_at) VALUES(?,?,?,?) " +
    "ON CONFLICT(owner_user_id) DO UPDATE SET updated_at=excluded.updated_at",
  ).run(ownerUserId, 1, 0, timestamp) as Database.RunResult;
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

  const row = db.prepare("SELECT * FROM memory_maintenance_state WHERE owner_user_id=?").get(ownerUserId) as MaintenanceRow | undefined;
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

export function saveUserMemory(db: Database.Database, input: MemoryInput): MemorySaveResult {
  const timestamp = now();
  const scopeType: UserMemoryScopeType = input.scopeType ?? "global";
  const scopeKey = input.scopeKey ?? "global";
  const status: UserMemoryStatus = input.status ?? "active";

  const existing = db.prepare(`
    SELECT id, status FROM user_memories
    WHERE owner_user_id=? AND scope_type=? AND scope_key=? AND kind='explicit' AND topic=? AND content=?
    LIMIT 1
  `).get(input.ownerUserId, scopeType, scopeKey, input.topic, input.content) as { id: string; status: string } | undefined;

  if (existing) {
    if (existing.status === "inactive" || existing.status === "archived" || existing.status === "superseded") {
      db.prepare("UPDATE user_memories SET status='active', updated_at=?, revision=revision+1 WHERE id=? AND owner_user_id=?")
        .run(timestamp, existing.id, input.ownerUserId);
      return { inserted: false, note: "resume-old-memory", memory: getUserMemory(db, input.ownerUserId, existing.id)!, existed: true };
    }
    return { inserted: false, note: "already-exists", memory: getUserMemory(db, input.ownerUserId, existing.id)!, existed: true };
  }

  const id = randomUUID();
  const conditions = JSON.stringify(input.conditions ?? []);
  db.prepare(`
    INSERT INTO user_memories(
      id,owner_user_id,scope_type,scope_key,kind,topic,preference_key,content,conditions_json,status,revision,superseded_by,created_at,updated_at,last_evidence_at,last_used_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    id,
    input.ownerUserId,
    scopeType,
    scopeKey,
    input.kind,
    input.topic,
    input.preferenceKey ?? null,
    input.content,
    conditions,
    status,
    1,
    null,
    timestamp,
    timestamp,
    null,
    null,
  );

  if (input.sourceEventId || input.rawExcerpt || input.taskId) {
    addMemoryEvidence(db, {
      ownerUserId: input.ownerUserId,
      memoryId: id,
      sourceEventId: input.sourceEventId,
      sourceKind: input.sourceKind ?? "user",
      taskId: input.taskId,
      rawExcerpt: input.rawExcerpt,
    });
  }

  return { inserted: true, note: "created", memory: getUserMemory(db, input.ownerUserId, id)!, existed: false };
}

export function updateUserMemory(
  db: Database.Database,
  ownerUserId: number,
  id: string,
  patch: MemoryPatch,
): UserMemory {
  const current = getUserMemory(db, ownerUserId, id);
  if (!current) throw new Error(`记忆不存在：${id}`);

  const next = {
    status: patch.status ?? current.status,
    topic: patch.topic ?? current.topic,
    preferenceKey: patch.preferenceKey ?? current.preferenceKey,
    content: patch.content ?? current.content,
    conditions: patch.conditions ?? current.conditions,
    supersededBy: patch.supersededBy ?? current.supersededBy,
  };

  db.prepare(`
    UPDATE user_memories
    SET topic=?, preference_key=?, content=?, conditions_json=?, status=?, revision=?, updated_at=?, superseded_by=COALESCE(?, superseded_by)
    WHERE owner_user_id=? AND id=?
  `).run(
    next.topic,
    next.preferenceKey ?? null,
    next.content,
    JSON.stringify(next.conditions),
    next.status,
    current.revision + 1,
    now(),
    next.supersededBy ?? null,
    ownerUserId,
    id,
  );

  return getUserMemory(db, ownerUserId, id)!;
}

export function disableUserMemory(db: Database.Database, ownerUserId: number, id: string): UserMemory {
  return updateUserMemory(db, ownerUserId, id, { status: "inactive", conditions: [] });
}

export function deleteUserMemory(db: Database.Database, ownerUserId: number, id: string): void {
  db.prepare("DELETE FROM user_memories WHERE owner_user_id=? AND id=?").run(ownerUserId, id);
  db.prepare("DELETE FROM memory_evidence WHERE owner_user_id=? AND memory_id=?").run(ownerUserId, id);
}

export function markMemoryUsed(db: Database.Database, ownerUserId: number, id: string): void {
  const nowAt = now();
  db.prepare("UPDATE user_memories SET last_used_at=?, revision=revision+1 WHERE owner_user_id=? AND id=?")
    .run(nowAt, ownerUserId, id);
}

export function addMemoryEvidence(db: Database.Database, input: {
  ownerUserId: number;
  memoryId: string;
  sourceKind: string;
  sourceEventId?: string;
  taskId?: string;
  rawExcerpt?: string;
}): UserMemoryEvidence {
  const nowAt = now();
  const id = randomUUID();

  db.prepare(`
    INSERT INTO memory_evidence(id,owner_user_id,memory_id,source_event_id,task_id,source_kind,raw_excerpt,created_at)
    VALUES(?,?,?,?,?,?,?,?)
  `).run(
    id,
    input.ownerUserId,
    input.memoryId,
    input.sourceEventId ?? null,
    input.taskId ?? null,
    input.sourceKind,
    input.rawExcerpt?.trim() ?? null,
    nowAt,
  );

  db.prepare("UPDATE user_memories SET last_evidence_at=?, revision=revision+1 WHERE owner_user_id=? AND id=?")
    .run(nowAt, input.ownerUserId, input.memoryId);

  const row = db.prepare("SELECT * FROM memory_evidence WHERE id=?").get(id) as MemoryEvidenceRow | undefined;
  if (!row) throw new Error("内存证据保存失败");
  return {
    id: row.id,
    sourceEventId: row.source_event_id ?? undefined,
    sourceKind: row.source_kind,
    taskId: row.task_id ?? undefined,
    rawExcerpt: row.raw_excerpt ?? undefined,
    createdAt: row.created_at,
  };
}

export function listMemoryEvidence(
  db: Database.Database,
  ownerUserId: number,
  memoryId: string,
): UserMemoryEvidence[] {
  const rows = db.prepare("SELECT * FROM memory_evidence WHERE owner_user_id=? AND memory_id=? ORDER BY created_at DESC")
    .all(ownerUserId, memoryId) as MemoryEvidenceRow[];
  return rows.map((row) => ({
    id: row.id,
    sourceEventId: row.source_event_id ?? undefined,
    sourceKind: row.source_kind,
    taskId: row.task_id ?? undefined,
    rawExcerpt: row.raw_excerpt ?? undefined,
    createdAt: row.created_at,
  }));
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

export function getMemoryByTopic(
  db: Database.Database,
  ownerUserId: number,
  topic: string,
): UserMemory[] {
  return db.prepare("SELECT * FROM user_memories WHERE owner_user_id=? AND topic=?")
    .all(ownerUserId, topic)
    .map((row) => toUserMemory(row as MemoryRow));
}

export type MemoryRecord = UserMemory;
