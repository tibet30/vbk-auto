/**
 * 通用智能体运行与工具调用持久化。
 *
 * 与 `parts/agent-workspace.ts` 的分工：线程/消息保存用户意图，本文件保存
 * "一次执行实际做了什么"。任何写入都必须由 `parts/agent-runtime-approval.ts`
 * 里的收据表证明，模型输出不构成事实。
 *
 * 排序约定：运行、工具调用、授权与收据都是追加写的账本，一律按 `rowid` 取序
 * （插入序）；`created_at` 只用于展示，不作为排序依据——同一毫秒内写入会退化成
 * 随机主键排序，时钟回拨也会打乱历史顺序。
 */

import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type {
  AgentActionKind,
  AgentActionRisk,
  AgentRun,
  AgentRunStatus,
  AgentToolCallRecord,
  AgentToolCallStatus,
} from "../../../../shared/contracts-agent-runtime.js";
import { now } from "./types.js";

/** transcript 只保存工具往返，属于主进程内部结构，不外泄到 renderer。 */
export type AgentTranscriptEntry = Record<string, unknown>;

type RunRow = {
  id: string;
  thread_id: string;
  owner_user_id: number;
  status: AgentRunStatus;
  intent: string;
  step: number;
  max_steps: number;
  transcript_json: string;
  error: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
};

type ToolCallRow = {
  id: string;
  run_id: string;
  thread_id: string;
  owner_user_id: number;
  skill_id: string;
  tool_name: string;
  arguments_json: string;
  status: AgentToolCallStatus;
  kind: AgentActionKind;
  risk: AgentActionRisk;
  idempotency_key: string;
  account_key: string | null;
  target_key: string | null;
  summary: string;
  diff: string | null;
  error: string | null;
  receipt_id: string | null;
  created_at: string;
  updated_at: string;
};

export const ACTIVE_RUN_STATUSES: AgentRunStatus[] = [
  "queued",
  "running",
  "waiting_approval",
  "needs_attention",
  "uncertain",
];

function fromRunRow(row: RunRow): AgentRun {
  return {
    id: row.id,
    threadId: row.thread_id,
    ownerUserId: row.owner_user_id,
    status: row.status,
    intent: row.intent,
    step: row.step,
    maxSteps: row.max_steps,
    ...(row.error ? { error: row.error } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.completed_at ? { completedAt: row.completed_at } : {}),
  };
}

function fromToolCallRow(row: ToolCallRow): AgentToolCallRecord {
  return {
    id: row.id,
    runId: row.run_id,
    threadId: row.thread_id,
    skillId: row.skill_id,
    toolName: row.tool_name,
    arguments: safeParse(row.arguments_json),
    status: row.status,
    kind: row.kind,
    risk: row.risk,
    idempotencyKey: row.idempotency_key,
    ...(row.account_key ? { accountKey: row.account_key } : {}),
    ...(row.target_key ? { targetKey: row.target_key } : {}),
    summary: row.summary,
    ...(row.diff ? { diff: row.diff } : {}),
    ...(row.error ? { error: row.error } : {}),
    ...(row.receipt_id ? { receiptId: row.receipt_id } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function safeParse(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export function createAgentRun(
  db: Database.Database,
  ownerUserId: number,
  input: { threadId: string; intent: string; maxSteps?: number },
): AgentRun {
  const timestamp = now();
  const id = randomUUID();
  db.prepare(`INSERT INTO agent_runs(
    id,thread_id,owner_user_id,status,intent,step,max_steps,transcript_json,created_at,updated_at
  ) VALUES(?,?,?,?,?,0,?,'[]',?,?)`).run(
    id, input.threadId, ownerUserId, "queued", input.intent,
    Math.max(1, input.maxSteps ?? 12), timestamp, timestamp,
  );
  return getAgentRun(db, ownerUserId, id)!;
}

export function getAgentRun(db: Database.Database, ownerUserId: number, id: string): AgentRun | undefined {
  const row = db.prepare("SELECT * FROM agent_runs WHERE owner_user_id=? AND id=?")
    .get(ownerUserId, id) as RunRow | undefined;
  return row ? fromRunRow(row) : undefined;
}

export function listAgentRuns(db: Database.Database, ownerUserId: number, threadId: string, limit = 20): AgentRun[] {
  return (db.prepare("SELECT * FROM agent_runs WHERE owner_user_id=? AND thread_id=? ORDER BY rowid DESC LIMIT ?")
    .all(ownerUserId, threadId, Math.max(1, limit)) as RunRow[]).map(fromRunRow);
}

/** 当前未终结的运行：面板只允许有一个"正在进行"的事实来源。 */
export function findActiveAgentRun(db: Database.Database, ownerUserId: number, threadId: string): AgentRun | undefined {
  const placeholders = ACTIVE_RUN_STATUSES.map(() => "?").join(",");
  const row = db.prepare(
    `SELECT * FROM agent_runs WHERE owner_user_id=? AND thread_id=? AND status IN (${placeholders})
     ORDER BY rowid DESC LIMIT 1`,
  ).get(ownerUserId, threadId, ...ACTIVE_RUN_STATUSES) as RunRow | undefined;
  return row ? fromRunRow(row) : undefined;
}

export function updateAgentRun(
  db: Database.Database,
  ownerUserId: number,
  id: string,
  patch: { status?: AgentRunStatus; step?: number; maxSteps?: number; error?: string | null; completedAt?: string | null },
): AgentRun {
  const current = getAgentRun(db, ownerUserId, id);
  if (!current) throw new Error(`智能体运行不存在：${id}`);
  db.prepare(`UPDATE agent_runs SET status=?,step=?,max_steps=?,error=?,completed_at=?,updated_at=?
    WHERE owner_user_id=? AND id=?`).run(
    patch.status ?? current.status,
    patch.step ?? current.step,
    patch.maxSteps ?? current.maxSteps,
    patch.error === null ? null : patch.error ?? current.error ?? null,
    patch.completedAt === null ? null : patch.completedAt ?? current.completedAt ?? null,
    now(), ownerUserId, id,
  );
  return getAgentRun(db, ownerUserId, id)!;
}

export function getAgentRunTranscript(
  db: Database.Database,
  ownerUserId: number,
  runId: string,
): AgentTranscriptEntry[] {
  const row = db.prepare("SELECT transcript_json FROM agent_runs WHERE owner_user_id=? AND id=?")
    .get(ownerUserId, runId) as { transcript_json: string } | undefined;
  if (!row) return [];
  try {
    const parsed: unknown = JSON.parse(row.transcript_json);
    return Array.isArray(parsed) ? (parsed as AgentTranscriptEntry[]) : [];
  } catch {
    return [];
  }
}

export function saveAgentRunTranscript(
  db: Database.Database,
  ownerUserId: number,
  runId: string,
  transcript: readonly AgentTranscriptEntry[],
): void {
  db.prepare("UPDATE agent_runs SET transcript_json=?,updated_at=? WHERE owner_user_id=? AND id=?")
    .run(JSON.stringify(transcript), now(), ownerUserId, runId);
}

export function insertAgentToolCall(
  db: Database.Database,
  ownerUserId: number,
  input: {
    runId: string;
    threadId: string;
    skillId: string;
    toolName: string;
    arguments: Record<string, unknown>;
    status: AgentToolCallStatus;
    kind: AgentActionKind;
    risk: AgentActionRisk;
    idempotencyKey: string;
    accountKey?: string;
    targetKey?: string;
    summary: string;
    diff?: string;
  },
): AgentToolCallRecord {
  const timestamp = now();
  const id = randomUUID();
  db.prepare(`INSERT INTO agent_tool_calls(
    id,run_id,thread_id,owner_user_id,skill_id,tool_name,arguments_json,status,kind,risk,
    idempotency_key,account_key,target_key,summary,diff,created_at,updated_at
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    id, input.runId, input.threadId, ownerUserId, input.skillId, input.toolName,
    JSON.stringify(input.arguments ?? {}), input.status, input.kind, input.risk,
    input.idempotencyKey, input.accountKey ?? null, input.targetKey ?? null,
    input.summary, input.diff ?? null, timestamp, timestamp,
  );
  return getAgentToolCall(db, ownerUserId, id)!;
}

export function getAgentToolCall(
  db: Database.Database,
  ownerUserId: number,
  id: string,
): AgentToolCallRecord | undefined {
  const row = db.prepare("SELECT * FROM agent_tool_calls WHERE owner_user_id=? AND id=?")
    .get(ownerUserId, id) as ToolCallRow | undefined;
  return row ? fromToolCallRow(row) : undefined;
}

export function findAgentToolCallByIdempotencyKey(
  db: Database.Database,
  idempotencyKey: string,
): AgentToolCallRecord | undefined {
  const row = db.prepare("SELECT * FROM agent_tool_calls WHERE idempotency_key=?")
    .get(idempotencyKey) as ToolCallRow | undefined;
  return row ? fromToolCallRow(row) : undefined;
}

export function updateAgentToolCall(
  db: Database.Database,
  ownerUserId: number,
  id: string,
  patch: {
    status?: AgentToolCallStatus;
    error?: string | null;
    receiptId?: string | null;
    targetKey?: string | null;
    summary?: string;
    diff?: string | null;
  },
): AgentToolCallRecord {
  const current = getAgentToolCall(db, ownerUserId, id);
  if (!current) throw new Error(`智能体工具调用不存在：${id}`);
  db.prepare(`UPDATE agent_tool_calls SET status=?,error=?,receipt_id=?,target_key=?,summary=?,diff=?,updated_at=?
    WHERE owner_user_id=? AND id=?`).run(
    patch.status ?? current.status,
    patch.error === null ? null : patch.error ?? current.error ?? null,
    patch.receiptId === null ? null : patch.receiptId ?? current.receiptId ?? null,
    patch.targetKey === null ? null : patch.targetKey ?? current.targetKey ?? null,
    patch.summary ?? current.summary,
    patch.diff === null ? null : patch.diff ?? current.diff ?? null,
    now(), ownerUserId, id,
  );
  return getAgentToolCall(db, ownerUserId, id)!;
}

export function listAgentToolCalls(db: Database.Database, ownerUserId: number, runId: string): AgentToolCallRecord[] {
  return (db.prepare("SELECT * FROM agent_tool_calls WHERE owner_user_id=? AND run_id=? ORDER BY rowid")
    .all(ownerUserId, runId) as ToolCallRow[]).map(fromToolCallRow);
}

export function listAgentToolCallsByThread(
  db: Database.Database,
  ownerUserId: number,
  threadId: string,
  limit = 20,
): AgentToolCallRecord[] {
  return (db.prepare(
    "SELECT * FROM agent_tool_calls WHERE owner_user_id=? AND thread_id=? ORDER BY rowid DESC LIMIT ?",
  ).all(ownerUserId, threadId, Math.max(1, limit)) as ToolCallRow[]).map(fromToolCallRow).reverse();
}

/** 应用重启时把中断在 `executing` 的动作转为 uncertain：结果未知，禁止直接重试。 */
export function markInterruptedAgentToolCallsUncertain(db: Database.Database, detail: string): number {
  return db.prepare(
    "UPDATE agent_tool_calls SET status='uncertain',error=?,updated_at=? WHERE status='executing'",
  ).run(detail, now()).changes;
}

/** 中断在 queued / running 的运行退回 needs_attention，等待运营继续或重开。 */
export function recoverInterruptedAgentRuns(db: Database.Database, detail: string): number {
  return db.prepare(
    "UPDATE agent_runs SET status='needs_attention',error=?,updated_at=? WHERE status IN ('queued','running')",
  ).run(detail, now()).changes;
}
