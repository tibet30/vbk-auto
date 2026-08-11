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
];

/** 在 VbkDatabase 启动时调用一次：按顺序应用 migrations。 */
export function runDatabaseMigrations(db: Database.Database): void {
  applyMigrations(db, MIGRATIONS);
}
