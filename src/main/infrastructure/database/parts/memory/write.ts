/**
 * 记忆 CRUD 写入：save / update / disable / delete。
 *
 *   - saveUserMemory：去重 + upsert；同 (scope, kind='explicit', topic, content) 已存在 → 跳过 / 重激活；
 *   - updateUserMemory：基于 patch 增量写；revision 自增；
 *   - disableUserMemory：status='inactive'，并清 conditions；
 *   - deleteUserMemory：删记忆行 + 关联 evidence 行。
 *
 * 读操作见 ./list.ts；evidence 写入见 ./evidence.ts。
 */

import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import type { MemoryInput, MemoryPatch, MemorySaveResult, UserMemory, UserMemoryScopeType, UserMemoryStatus } from "../../../../../shared/contracts.js";
import { now } from "../types.js";
import { getUserMemory } from "./list.js";
import { addMemoryEvidence } from "./evidence.js";

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