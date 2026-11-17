/**
 * 通用智能体授权与操作收据持久化。
 *
 * 收据（receipt）是"外部世界实际发生了什么"的唯一事实来源：
 *   - `idempotency_key` 唯一索引保证同一动作重复提交不会产生第二次写入；
 *   - `status='uncertain'` 表示写入可能已到达但未确认，必须核查后才允许重试。
 */

import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type {
  AgentActionReceipt,
  AgentApprovalScope,
  AgentArtifact,
  AgentPermissionGrant,
  AgentReceiptStatus,
} from "../../../../shared/contracts-agent-runtime.js";
import { now } from "./types.js";

type GrantRow = {
  id: string;
  owner_user_id: number;
  thread_id: string;
  run_id: string;
  tool_call_id: string;
  scope: AgentApprovalScope;
  action: string;
  target_key: string;
  account_key: string;
  granted_at: string;
  revoked_at: string | null;
  revoked_reason: string | null;
};

type ReceiptRow = {
  id: string;
  owner_user_id: number;
  thread_id: string;
  run_id: string;
  tool_call_id: string;
  action: string;
  target_key: string;
  account_key: string;
  idempotency_key: string;
  status: AgentReceiptStatus;
  before_text: string | null;
  result: string;
  detail: string | null;
  artifact_json: string | null;
  created_at: string;
};

function parseArtifact(value: string | null): AgentArtifact | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as AgentArtifact;
    if (!parsed || typeof parsed.path !== "string" || !Array.isArray(parsed.files)) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

function fromGrantRow(row: GrantRow): AgentPermissionGrant {
  return {
    id: row.id,
    threadId: row.thread_id,
    runId: row.run_id,
    toolCallId: row.tool_call_id,
    scope: row.scope,
    action: row.action,
    targetKey: row.target_key,
    accountKey: row.account_key,
    grantedAt: row.granted_at,
    ...(row.revoked_at ? { revokedAt: row.revoked_at } : {}),
    ...(row.revoked_reason ? { revokedReason: row.revoked_reason } : {}),
  };
}

function fromReceiptRow(row: ReceiptRow): AgentActionReceipt {
  return {
    id: row.id,
    threadId: row.thread_id,
    runId: row.run_id,
    toolCallId: row.tool_call_id,
    action: row.action,
    targetKey: row.target_key,
    accountKey: row.account_key,
    idempotencyKey: row.idempotency_key,
    status: row.status,
    ...(row.before_text ? { before: row.before_text } : {}),
    result: row.result,
    ...(row.detail ? { detail: row.detail } : {}),
    ...(parseArtifact(row.artifact_json) ? { artifact: parseArtifact(row.artifact_json)! } : {}),
    createdAt: row.created_at,
  };
}

export function createAgentPermissionGrant(
  db: Database.Database,
  ownerUserId: number,
  input: {
    threadId: string;
    runId: string;
    toolCallId: string;
    scope: AgentApprovalScope;
    action: string;
    targetKey: string;
    accountKey: string;
  },
): AgentPermissionGrant {
  const id = randomUUID();
  db.prepare(`INSERT INTO agent_permission_grants(
    id,owner_user_id,thread_id,run_id,tool_call_id,scope,action,target_key,account_key,granted_at
  ) VALUES(?,?,?,?,?,?,?,?,?,?)`).run(
    id, ownerUserId, input.threadId, input.runId, input.toolCallId, input.scope,
    input.action, input.targetKey, input.accountKey, now(),
  );
  return listAgentPermissionGrants(db, ownerUserId, input.threadId)
    .find((grant) => grant.id === id)!;
}

export function listAgentPermissionGrants(
  db: Database.Database,
  ownerUserId: number,
  threadId: string,
): AgentPermissionGrant[] {
  return (db.prepare(
    "SELECT * FROM agent_permission_grants WHERE owner_user_id=? AND thread_id=? ORDER BY rowid DESC",
  ).all(ownerUserId, threadId) as GrantRow[]).map(fromGrantRow);
}

/** 授权失效：目录变更、任务归档或运营撤销后，旧授权不得继续沿用。 */
export function revokeAgentPermissionGrants(
  db: Database.Database,
  ownerUserId: number,
  threadId: string,
  reason: string,
): number {
  const result = db.prepare(`UPDATE agent_permission_grants SET revoked_at=?,revoked_reason=?
    WHERE owner_user_id=? AND thread_id=? AND revoked_at IS NULL`).run(now(), reason, ownerUserId, threadId);
  return result.changes;
}

/** 幂等保存收据：同一 idempotency_key 已存在时不覆盖，返回既有事实。 */
export function saveAgentActionReceipt(
  db: Database.Database,
  ownerUserId: number,
  input: {
    threadId: string;
    runId: string;
    toolCallId: string;
    action: string;
    targetKey: string;
    accountKey: string;
    idempotencyKey: string;
    status: AgentReceiptStatus;
    before?: string;
    result: string;
    detail?: string;
    artifact?: AgentArtifact;
  },
): { receipt: AgentActionReceipt; created: boolean } {
  const id = randomUUID();
  const result = db.prepare(`INSERT INTO agent_action_receipts(
    id,owner_user_id,thread_id,run_id,tool_call_id,action,target_key,account_key,
    idempotency_key,status,before_text,result,detail,artifact_json,created_at
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  ON CONFLICT(idempotency_key) DO NOTHING`).run(
    id, ownerUserId, input.threadId, input.runId, input.toolCallId, input.action,
    input.targetKey, input.accountKey, input.idempotencyKey, input.status,
    input.before ?? null, input.result, input.detail ?? null,
    input.artifact ? JSON.stringify(input.artifact) : null, now(),
  );
  const existing = findAgentActionReceiptByIdempotencyKey(db, input.idempotencyKey);
  if (!existing) throw new Error(`操作收据写入失败：${input.idempotencyKey}`);
  return { receipt: existing, created: result.changes > 0 };
}

export function getAgentActionReceipt(
  db: Database.Database,
  ownerUserId: number,
  id: string,
): AgentActionReceipt | undefined {
  const row = db.prepare("SELECT * FROM agent_action_receipts WHERE owner_user_id=? AND id=?")
    .get(ownerUserId, id) as ReceiptRow | undefined;
  return row ? fromReceiptRow(row) : undefined;
}

export function findAgentActionReceiptByIdempotencyKey(
  db: Database.Database,
  idempotencyKey: string,
): AgentActionReceipt | undefined {
  const row = db.prepare("SELECT * FROM agent_action_receipts WHERE idempotency_key=?")
    .get(idempotencyKey) as ReceiptRow | undefined;
  return row ? fromReceiptRow(row) : undefined;
}

/**
 * 只允许 `uncertain → succeeded/failed` 的单向收敛：核查回读后写入最终事实。
 * 幂等键不变，因此后续重试仍然命中同一张收据，不会产生第二次写入。
 */
export function markAgentActionReceiptReconciled(
  db: Database.Database,
  ownerUserId: number,
  id: string,
  input: { status: Exclude<AgentReceiptStatus, "uncertain">; detail: string },
): AgentActionReceipt {
  const current = getAgentActionReceipt(db, ownerUserId, id);
  if (!current) throw new Error(`操作收据不存在：${id}`);
  if (current.status !== "uncertain") return current;
  db.prepare("UPDATE agent_action_receipts SET status=?,detail=? WHERE owner_user_id=? AND id=?")
    .run(input.status, input.detail, ownerUserId, id);
  return getAgentActionReceipt(db, ownerUserId, id)!;
}

export function listAgentActionReceipts(
  db: Database.Database,
  ownerUserId: number,
  threadId: string,
  limit = 20,
): AgentActionReceipt[] {
  return (db.prepare(
    "SELECT * FROM agent_action_receipts WHERE owner_user_id=? AND thread_id=? ORDER BY rowid DESC LIMIT ?",
  ).all(ownerUserId, threadId, Math.max(1, limit)) as ReceiptRow[]).map(fromReceiptRow).reverse();
}
