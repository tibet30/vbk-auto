/**
 * 本地记忆存储的 DB 行形状 + 行 ↔ 域模型转换：
 *   - MemoryRow / MemoryEvidenceRow / MaintenanceRow：与 SQLite 列对齐的内部表示；
 *   - parseConditions：JSON 字符串 → string[]；
 *   - toUserMemory：MemoryRow → UserMemory 域对象。
 *
 * 单独成文件是因为 row 类型会被 list / write / evidence / state 四块同时引用，
 * 集中维护可避免互相重复定义。
 */

import type Database from "better-sqlite3";
import type {
  UserMemory,
  UserMemoryEvidence,
  UserMemoryKind,
  UserMemoryScopeType,
  UserMemoryStatus,
} from "../../../../../shared/contracts.js";

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

export function parseConditions(raw: string): string[] {
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

export function toUserMemory(record: MemoryRow): UserMemory {
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

/** 占位 re-export：保证 reader 一眼定位域模型来源；运行时无副作用。 */
export type { UserMemoryEvidence };

/** 旧别名：保持调用方 `MemoryRecord = UserMemory` 兼容。 */
export type MemoryRecord = UserMemory;