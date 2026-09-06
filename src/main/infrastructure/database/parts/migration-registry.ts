/**
 * 数据库迁移清单（声明式）：
 *   - 0001_baseline：建表（projects / messages / research_tasks / automation_runs /
 *     settings / login_sessions / planning_generation / migrations）；
 *   - 0002_projects_basic_info_saved：projects 加 basic_info_saved 列；
 *   - 0003_login_sessions_ciphertext：login_sessions 加 cookies_ciphertext 列
 *     （历史 Keychain 加密迁移期保留列，新代码不读 / 不写）；
 *   - 0004_login_sessions_indexes：messages / research_tasks / automation_runs /
 *     planning_generation 上的索引；
 *   - 0005_operation_log：新建 operation_log 表 + 索引；
 *   - 0006_login_sessions_drop_plaintext：无 statements 的标记，原本由
 *     `dropPlaintextCookiesColumn` 显式调用以 DROP cookies_json。已删除
 *     Keychain 加密层移除后该函数被移除；标记 id 保留以便不破坏历史 db 文件
 *     的 migrations 表。
 *   - 0007_product_naming：把本地业务实体从 projects 迁为 products，并把
 *     关联表的 project_id / project_name 改为 local_product_id / product_name。
 *   - 0009_workflow_tasks：持久化一键创建的后台任务与当前阶段。
 *   - 0010_agent_snapshots：agent 会话恢复与恢复上下文快照。
 *   - 0011_user_memories：用户偏好记忆（显式记忆 + 证据 + 维护状态）。
 *   - 0012_ctrip_poi_availability_cache：携程 POI 营业状态成功缓存。
 *
 * 注：
 *   - cookies 不再写入 SQLite：本地 0600 atomic cookie store 才是 cookie
 *     快照的真实存储（见 `../vbk-cookie-store.ts`）。SQLite login_sessions
 *     表只保留 account_key / account_name / saved_at 等元数据；
 *   - FK / index：当前 SQLite 默认不强制外键，但索引已创建。
 */

import type Database from "better-sqlite3";
import { applyMigrations } from "./migrations.js";
import type { Migration } from "./migrations.js";

const BASELINE_STATEMENTS: string[] = [
  `CREATE TABLE IF NOT EXISTS migrations (
    id TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, status TEXT NOT NULL, product_id TEXT,
    product_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL,
    task_status TEXT, created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS research_tasks (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, label TEXT NOT NULL, type TEXT NOT NULL,
    status TEXT NOT NULL, state TEXT NOT NULL, detail TEXT, evidence_json TEXT NOT NULL DEFAULT '[]'
  )`,
  `CREATE TABLE IF NOT EXISTS automation_runs (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, payload_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS login_sessions (
    account_key TEXT PRIMARY KEY,
    account_name TEXT NOT NULL,
    cookies_json TEXT NOT NULL,
    saved_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS planning_generation (
    project_id TEXT PRIMARY KEY,
    state_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
];

const MIGRATIONS: Migration[] = [
  {
    id: "0001_baseline",
    statements: BASELINE_STATEMENTS,
  },
  {
    id: "0002_projects_basic_info_saved",
    statements: [
      `ALTER TABLE projects ADD COLUMN basic_info_saved INTEGER NOT NULL DEFAULT 0`,
    ],
  },
  {
    id: "0003_login_sessions_ciphertext",
    statements: [
      `ALTER TABLE login_sessions ADD COLUMN cookies_ciphertext TEXT`,
    ],
  },
  {
    id: "0004_login_sessions_indexes",
    statements: [
      `CREATE INDEX IF NOT EXISTS idx_messages_project_id ON messages(project_id)`,
      `CREATE INDEX IF NOT EXISTS idx_research_tasks_project_id ON research_tasks(project_id)`,
      `CREATE INDEX IF NOT EXISTS idx_automation_runs_project_id ON automation_runs(project_id)`,
      `CREATE INDEX IF NOT EXISTS idx_planning_generation_updated_at ON planning_generation(updated_at)`,
    ],
  },
  {
    id: "0005_operation_log",
    statements: [
      `CREATE TABLE IF NOT EXISTS operation_log (
        id TEXT PRIMARY KEY,
        project_id TEXT,
        project_name TEXT,
        stage TEXT,
        phase TEXT,
        type TEXT NOT NULL,
        name TEXT NOT NULL,
        status TEXT NOT NULL,
        attempt INTEGER NOT NULL DEFAULT 1,
        started_at TEXT NOT NULL,
        duration_ms INTEGER NOT NULL DEFAULT 0,
        target TEXT,
        message TEXT,
        payload_json TEXT NOT NULL DEFAULT '{}'
      )`,
      `CREATE INDEX IF NOT EXISTS idx_operation_log_started_at ON operation_log(started_at DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_operation_log_project_id ON operation_log(project_id)`,
    ],
  },
  // 0006 是不带 statements 的"标记"：实际 DROP 由 dropPlaintextCookiesColumn 在
  // 全部 cookies_ciphertext 都填齐时显式调用，调用方再 INSERT OR IGNORE 这条 id。
  { id: "0006_login_sessions_drop_plaintext", statements: [] },
  {
    id: "0007_product_naming",
    statements: [
      `ALTER TABLE projects RENAME TO products`,
      `ALTER TABLE messages RENAME COLUMN project_id TO local_product_id`,
      `ALTER TABLE research_tasks RENAME COLUMN project_id TO local_product_id`,
      `ALTER TABLE automation_runs RENAME COLUMN project_id TO local_product_id`,
      `ALTER TABLE planning_generation RENAME COLUMN project_id TO local_product_id`,
      `ALTER TABLE operation_log RENAME COLUMN project_id TO local_product_id`,
      `ALTER TABLE operation_log RENAME COLUMN project_name TO product_name`,
      `DROP INDEX IF EXISTS idx_messages_project_id`,
      `DROP INDEX IF EXISTS idx_research_tasks_project_id`,
      `DROP INDEX IF EXISTS idx_automation_runs_project_id`,
      `DROP INDEX IF EXISTS idx_operation_log_project_id`,
      `CREATE INDEX IF NOT EXISTS idx_messages_local_product_id ON messages(local_product_id)`,
      `CREATE INDEX IF NOT EXISTS idx_research_tasks_local_product_id ON research_tasks(local_product_id)`,
      `CREATE INDEX IF NOT EXISTS idx_automation_runs_local_product_id ON automation_runs(local_product_id)`,
      `CREATE INDEX IF NOT EXISTS idx_operation_log_local_product_id ON operation_log(local_product_id)`,
    ],
  },
  {
    id: "0008_runtime_log_metadata",
    statements: [
      `ALTER TABLE operation_log ADD COLUMN level TEXT NOT NULL DEFAULT 'info'`,
      `ALTER TABLE operation_log ADD COLUMN source TEXT NOT NULL DEFAULT 'automation'`,
      `ALTER TABLE operation_log ADD COLUMN module TEXT`,
      `CREATE INDEX IF NOT EXISTS idx_operation_log_level ON operation_log(level)`,
      `CREATE INDEX IF NOT EXISTS idx_operation_log_source ON operation_log(source)`,
    ],
  },
  {
    id: "0009_workflow_tasks",
    statements: [
      `CREATE TABLE IF NOT EXISTS workflow_tasks (
        id TEXT PRIMARY KEY,
        local_product_id TEXT NOT NULL,
        product_name TEXT NOT NULL,
        status TEXT NOT NULL,
        stage TEXT NOT NULL,
        progress INTEGER NOT NULL DEFAULT 0,
        message TEXT NOT NULL,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT
      )`,
      `CREATE INDEX IF NOT EXISTS idx_workflow_tasks_product_id ON workflow_tasks(local_product_id)`,
      `CREATE INDEX IF NOT EXISTS idx_workflow_tasks_created_at ON workflow_tasks(created_at DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_workflow_tasks_status ON workflow_tasks(status)`,
    ],
  },
  {
    id: "0010_agent_snapshots",
    statements: [
      `CREATE TABLE IF NOT EXISTS agent_snapshots (
        local_product_id TEXT PRIMARY KEY,
        snapshot_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_agent_snapshots_updated_at ON agent_snapshots(updated_at DESC)`,
    ],
  },
  {
    id: "0011_user_memories",
    statements: [
      `CREATE TABLE IF NOT EXISTS user_memories (
        id TEXT PRIMARY KEY,
        owner_user_id INTEGER NOT NULL,
        scope_type TEXT NOT NULL,
        scope_key TEXT NOT NULL,
        kind TEXT NOT NULL,
        topic TEXT NOT NULL,
        preference_key TEXT,
        content TEXT NOT NULL,
        conditions_json TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 1,
        superseded_by TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_evidence_at TEXT,
        last_used_at TEXT,
        CHECK (scope_type IN ('global', 'product')),
        CHECK (kind IN ('explicit', 'inferred')),
        CHECK (status IN ('active', 'pending', 'inactive', 'archived', 'superseded'))
      )`,
      `CREATE TABLE IF NOT EXISTS memory_evidence (
        id TEXT PRIMARY KEY,
        owner_user_id INTEGER NOT NULL,
        memory_id TEXT NOT NULL,
        source_event_id TEXT,
        task_id TEXT,
        source_kind TEXT NOT NULL,
        raw_excerpt TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY(memory_id) REFERENCES user_memories(id) ON DELETE CASCADE
      )`,
      `CREATE TABLE IF NOT EXISTS memory_maintenance_state (
        owner_user_id INTEGER PRIMARY KEY,
        auto_capture INTEGER NOT NULL DEFAULT 1,
        scope_key TEXT,
        last_task_id TEXT,
        pending_count INTEGER NOT NULL DEFAULT 0,
        last_success_at TEXT,
        updated_at TEXT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_user_memories_owner_scope_status_updated
        ON user_memories(owner_user_id, scope_type, scope_key, status, updated_at DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_user_memories_owner_status_topic
        ON user_memories(owner_user_id, status, topic)`,
      `CREATE INDEX IF NOT EXISTS idx_memory_evidence_owner_memory
        ON memory_evidence(owner_user_id, memory_id, created_at DESC)`,
      `CREATE UNIQUE INDEX IF NOT EXISTS uq_memory_evidence_event
        ON memory_evidence(owner_user_id, source_event_id, source_kind, memory_id)
        WHERE source_event_id IS NOT NULL`,
    ],
  },
  {
    id: "0012_ctrip_poi_availability_cache",
    statements: [
      `CREATE TABLE IF NOT EXISTS ctrip_poi_availability_cache (
        poi_id INTEGER PRIMARY KEY,
        status TEXT NOT NULL CHECK (status IN ('available', 'suspended')),
        open_status TEXT NOT NULL,
        lately_open_time TEXT,
        verified_at TEXT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_ctrip_poi_availability_cache_verified_at
        ON ctrip_poi_availability_cache(verified_at DESC)`,
    ],
  },
];

/** 在 VbkDatabase 启动时调用一次：按顺序应用 migrations。 */
export function runDatabaseMigrations(db: Database.Database): void {
  applyMigrations(db, MIGRATIONS);
}
