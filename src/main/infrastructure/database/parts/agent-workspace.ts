import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type {
  AgentThread,
  AgentThreadDetail,
  AgentThreadMessage,
  AgentThreadMessageRole,
  AgentThreadStatus,
  AgentThreadSummary,
  CreateAgentThreadInput,
  UpdateAgentThreadInput,
} from "../../../../shared/contracts-agent-workspace.js";
import { now } from "./types.js";

type ThreadRow = {
  id: string;
  owner_user_id: number;
  title: string;
  status: AgentThreadStatus;
  pinned: number;
  working_directory: string | null;
  linked_product_id: string | null;
  summary_json: string | null;
  enabled_skills_json: string | null;
  created_at: string;
  updated_at: string;
  unread: number;
  message_count: number;
};

type MessageRow = {
  id: string;
  thread_id: string;
  role: AgentThreadMessageRole;
  content: string;
  created_at: string;
};

function parseSummary(value: string | null): AgentThreadSummary | undefined {
  if (!value) return undefined;
  try { return JSON.parse(value) as AgentThreadSummary; } catch { return undefined; }
}

function parseEnabledSkills(value: string | null): string[] | undefined {
  if (!value) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : undefined;
  } catch {
    return undefined;
  }
}

function fromThreadRow(row: ThreadRow): AgentThread {
  return {
    id: row.id,
    ownerUserId: row.owner_user_id,
    title: row.title,
    status: row.status,
    pinned: Boolean(row.pinned),
    ...(row.working_directory ? { workingDirectory: row.working_directory } : {}),
    ...(row.linked_product_id ? { linkedProductId: row.linked_product_id } : {}),
    ...(parseEnabledSkills(row.enabled_skills_json) !== undefined
      ? { enabledSkills: parseEnabledSkills(row.enabled_skills_json)! }
      : {}),
    ...(parseSummary(row.summary_json) ? { summary: parseSummary(row.summary_json) } : {}),
    unread: Boolean(row.unread),
    messageCount: row.message_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function fromMessageRow(row: MessageRow): AgentThreadMessage {
  return { id: row.id, threadId: row.thread_id, role: row.role, content: row.content, createdAt: row.created_at };
}

const THREAD_SELECT = `SELECT t.*,
  (SELECT COUNT(*) FROM agent_thread_messages m WHERE m.thread_id=t.id) AS message_count
  FROM agent_threads t`;

export function createAgentThread(db: Database.Database, ownerUserId: number, input: CreateAgentThreadInput): AgentThread {
  const timestamp = now();
  const id = randomUUID();
  const title = input.title?.trim() || "新任务";
  db.prepare(`INSERT INTO agent_threads(
    id,owner_user_id,title,status,pinned,working_directory,linked_product_id,summary_json,created_at,updated_at
  ) VALUES(?,?,?,?,?,?,?,?,?,?)`).run(
    id, ownerUserId, title, "draft", 0, input.workingDirectory ?? null,
    input.linkedProductId ?? null, null, timestamp, timestamp,
  );
  if (input.prompt?.trim()) addAgentThreadMessage(db, ownerUserId, id, "user", input.prompt);
  return getAgentThread(db, ownerUserId, id)!;
}

export function getAgentThread(db: Database.Database, ownerUserId: number, id: string): AgentThread | undefined {
  const row = db.prepare(`${THREAD_SELECT} WHERE t.owner_user_id=? AND t.id=?`).get(ownerUserId, id) as ThreadRow | undefined;
  return row ? fromThreadRow(row) : undefined;
}

export function listAgentThreads(db: Database.Database, ownerUserId: number): AgentThread[] {
  return (db.prepare(`${THREAD_SELECT} WHERE t.owner_user_id=? ORDER BY t.pinned DESC,t.updated_at DESC,t.rowid DESC`)
    .all(ownerUserId) as ThreadRow[]).map(fromThreadRow);
}

export function updateAgentThread(
  db: Database.Database,
  ownerUserId: number,
  id: string,
  patch: UpdateAgentThreadInput & { summary?: AgentThreadSummary; runtimeStatus?: AgentThreadStatus },
): AgentThread {
  const current = getAgentThread(db, ownerUserId, id);
  if (!current) throw new Error(`智能体任务不存在：${id}`);
  const next = {
    title: patch.title?.trim() || current.title,
    // null 表示"恢复全部启用"；数组（含空数组）表示只启用这些。
    enabledSkills: patch.enabledSkills === null
      ? undefined
      : patch.enabledSkills ?? current.enabledSkills,
    status: patch.runtimeStatus ?? patch.status ?? current.status,
    pinned: patch.pinned ?? current.pinned,
    workingDirectory: patch.workingDirectory === null ? null : patch.workingDirectory ?? current.workingDirectory ?? null,
    summary: patch.summary ?? current.summary,
  };
  db.prepare(`UPDATE agent_threads SET title=?,status=?,pinned=?,working_directory=?,summary_json=?,
    enabled_skills_json=?,updated_at=?
    WHERE owner_user_id=? AND id=?`).run(
    next.title, next.status, next.pinned ? 1 : 0, next.workingDirectory,
    next.summary ? JSON.stringify(next.summary) : null,
    next.enabledSkills ? JSON.stringify([...new Set(next.enabledSkills)]) : null,
    now(), ownerUserId, id,
  );
  return getAgentThread(db, ownerUserId, id)!;
}

export function deleteAgentThread(db: Database.Database, ownerUserId: number, id: string): void {
  if (!getAgentThread(db, ownerUserId, id)) throw new Error(`智能体任务不存在：${id}`);
  const remove = db.transaction(() => {
    db.prepare("DELETE FROM agent_action_receipts WHERE owner_user_id=? AND thread_id=?").run(ownerUserId, id);
    db.prepare("DELETE FROM agent_tool_calls WHERE owner_user_id=? AND thread_id=?").run(ownerUserId, id);
    db.prepare("DELETE FROM agent_permission_grants WHERE owner_user_id=? AND thread_id=?").run(ownerUserId, id);
    db.prepare("DELETE FROM agent_runs WHERE owner_user_id=? AND thread_id=?").run(ownerUserId, id);
    db.prepare("DELETE FROM agent_thread_messages WHERE thread_id=?").run(id);
    db.prepare("DELETE FROM agent_threads WHERE owner_user_id=? AND id=?").run(ownerUserId, id);
  });
  remove();
}

export function addAgentThreadMessage(
  db: Database.Database,
  ownerUserId: number,
  threadId: string,
  role: AgentThreadMessageRole,
  content: string,
): AgentThreadMessage {
  if (!getAgentThread(db, ownerUserId, threadId)) throw new Error(`智能体任务不存在：${threadId}`);
  const message: AgentThreadMessage = { id: randomUUID(), threadId, role, content: content.trim(), createdAt: now() };
  if (!message.content) throw new Error("消息内容不能为空。");
  db.prepare("INSERT INTO agent_thread_messages(id,thread_id,role,content,created_at) VALUES(?,?,?,?,?)")
    .run(message.id, message.threadId, message.role, message.content, message.createdAt);
  db.prepare("UPDATE agent_threads SET updated_at=?,unread=? WHERE owner_user_id=? AND id=?")
    .run(message.createdAt, role === "user" ? 0 : 1, ownerUserId, threadId);
  return message;
}

export function markAgentThreadRead(db: Database.Database, ownerUserId: number, threadId: string): void {
  db.prepare("UPDATE agent_threads SET unread=0 WHERE owner_user_id=? AND id=?").run(ownerUserId, threadId);
}

export function listAgentThreadMessages(db: Database.Database, ownerUserId: number, threadId: string): AgentThreadMessage[] {
  if (!getAgentThread(db, ownerUserId, threadId)) throw new Error(`智能体任务不存在：${threadId}`);
  // 消息表是追加写：按 rowid 就是插入序。用 created_at 排序时，同一毫秒内的两条消息
  // 只能靠随机 UUID 决出先后（历史上就出现过对话顺序反转），时钟回拨同样会打乱顺序。
  return (db.prepare("SELECT * FROM agent_thread_messages WHERE thread_id=? ORDER BY rowid").all(threadId) as MessageRow[])
    .map(fromMessageRow);
}

export function getAgentThreadDetail(db: Database.Database, ownerUserId: number, id: string): AgentThreadDetail {
  const thread = getAgentThread(db, ownerUserId, id);
  if (!thread) throw new Error(`智能体任务不存在：${id}`);
  return { thread, messages: listAgentThreadMessages(db, ownerUserId, id) };
}

