/**
 * 0019_agent_runtime：通用智能体的运行、工具调用、授权与操作收据。
 *
 * 四张表对应四类事实，禁止互相替代：
 *   - `agent_runs`：一次执行的意图、步数、状态与工具往返 transcript；
 *   - `agent_tool_calls`：模型提出的一次受 Schema 约束的动作（含审批与幂等键）；
 *   - `agent_permission_grants`：运营给出的授权及其失效状态；
 *   - `agent_action_receipts`：外部世界实际发生的结果（唯一写入事实来源）。
 *
 * `idempotency_key` 唯一约束是"重复提交同一动作不会重复写入"的数据库级保证。
 */

import type { Migration } from "./migrations.js";

export const agentRuntimeMigration: Migration = {
  id: "0019_agent_runtime",
  statements: [
    `CREATE TABLE IF NOT EXISTS agent_runs (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      owner_user_id INTEGER NOT NULL,
      status TEXT NOT NULL,
      intent TEXT NOT NULL,
      step INTEGER NOT NULL DEFAULT 0,
      max_steps INTEGER NOT NULL DEFAULT 12,
      transcript_json TEXT NOT NULL DEFAULT '[]',
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT,
      CHECK (status IN ('queued','running','waiting_approval','needs_attention','cancelled','rejected','uncertain','completed','failed'))
    )`,
    `CREATE INDEX IF NOT EXISTS idx_agent_runs_thread_created
      ON agent_runs(thread_id,created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_agent_runs_owner_status
      ON agent_runs(owner_user_id,status)`,
    `CREATE TABLE IF NOT EXISTS agent_tool_calls (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      owner_user_id INTEGER NOT NULL,
      skill_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      arguments_json TEXT NOT NULL,
      status TEXT NOT NULL,
      kind TEXT NOT NULL,
      risk TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      account_key TEXT,
      target_key TEXT,
      summary TEXT NOT NULL,
      diff TEXT,
      error TEXT,
      receipt_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      CHECK (status IN ('awaiting_approval','denied','executing','succeeded','failed','uncertain')),
      CHECK (kind IN ('read','write','delete'))
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_tool_calls_idempotency
      ON agent_tool_calls(idempotency_key)`,
    `CREATE INDEX IF NOT EXISTS idx_agent_tool_calls_run_created
      ON agent_tool_calls(run_id,created_at,id)`,
    `CREATE INDEX IF NOT EXISTS idx_agent_tool_calls_thread_status
      ON agent_tool_calls(thread_id,status)`,
    `CREATE TABLE IF NOT EXISTS agent_permission_grants (
      id TEXT PRIMARY KEY,
      owner_user_id INTEGER NOT NULL,
      thread_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      tool_call_id TEXT NOT NULL,
      scope TEXT NOT NULL,
      action TEXT NOT NULL,
      target_key TEXT NOT NULL,
      account_key TEXT NOT NULL,
      granted_at TEXT NOT NULL,
      revoked_at TEXT,
      revoked_reason TEXT,
      CHECK (scope IN ('once','thread'))
    )`,
    `CREATE INDEX IF NOT EXISTS idx_agent_permission_grants_thread_granted
      ON agent_permission_grants(thread_id,granted_at DESC)`,
    `CREATE TABLE IF NOT EXISTS agent_action_receipts (
      id TEXT PRIMARY KEY,
      owner_user_id INTEGER NOT NULL,
      thread_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      tool_call_id TEXT NOT NULL,
      action TEXT NOT NULL,
      target_key TEXT NOT NULL,
      account_key TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      status TEXT NOT NULL,
      before_text TEXT,
      result TEXT NOT NULL,
      detail TEXT,
      created_at TEXT NOT NULL,
      CHECK (status IN ('succeeded','failed','uncertain'))
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_action_receipts_idempotency
      ON agent_action_receipts(idempotency_key)`,
    `CREATE INDEX IF NOT EXISTS idx_agent_action_receipts_thread_created
      ON agent_action_receipts(thread_id,created_at DESC)`,
  ],
};

/**
 * 0020_agent_receipt_artifact：收据记录结构化产物（文件/目录、文件列表、预览入口）。
 *
 * 之前产物信息只存在于 `result` 文本里，界面无法列文件树也无法打开；补一列 JSON，
 * 打开动作仍以任务授权目录重新校验，不接受 renderer 传入任意路径。
 */
export const agentReceiptArtifactMigration: Migration = {
  id: "0020_agent_receipt_artifact",
  statements: [
    `ALTER TABLE agent_action_receipts ADD COLUMN artifact_json TEXT`,
  ],
};

/**
 * 0021_agent_thread_enabled_skills：任务级 Skill 启停。
 *
 * 存 JSON 数组；NULL 表示"全部启用"（历史任务与新建任务的默认语义），
 * 空数组表示一个都不启用——两者不能混为一谈。
 */
export const agentThreadSkillsMigration: Migration = {
  id: "0021_agent_thread_enabled_skills",
  statements: [
    `ALTER TABLE agent_threads ADD COLUMN enabled_skills_json TEXT`,
  ],
};
