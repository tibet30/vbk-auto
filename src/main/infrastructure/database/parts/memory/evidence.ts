/**
 * 记忆 evidence 写入 + 读取：
 *   - addMemoryEvidence：插入一条证据 + 自增 parent memory 的 last_evidence_at / revision；
 *   - listMemoryEvidence：按 created_at DESC 列出某 memory 的全部 evidence；
 *   - markMemoryUsed：仅刷 last_used_at + revision（不写入 evidence）。
 */

import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import type { UserMemoryEvidence } from "../../../../../shared/contracts.js";
import { now } from "../types.js";
import type { MemoryEvidenceRow } from "./types.js";

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

export function markMemoryUsed(db: Database.Database, ownerUserId: number, id: string): void {
  const nowAt = now();
  db.prepare("UPDATE user_memories SET last_used_at=?, revision=revision+1 WHERE owner_user_id=? AND id=?")
    .run(nowAt, ownerUserId, id);
}