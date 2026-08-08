/**
 * 数据库迁移与版本控制。
 *
 * 设计目标：
 *   - 每条 migration 有唯一 id（如 0001_baseline），通过 migrations 表记录已应用 id；
 *   - 启动时按声明顺序应用未应用过的 migration，每条都包在事务里；
 *   - 兼容旧 db：列不存在时 ALTER 添加，索引重复用 IF NOT EXISTS；
 *   - 失败抛错回滚（外层不再有"半应用"状态）。
 *
 * 这份模块只暴露 applyMigrations 与 hasColumn，db 层调用方负责传入 db handle。
 */

import type Database from "better-sqlite3";

/** 单条 migration 的声明。 */
export interface Migration {
  id: string;
  statements: string[];
}

/**
 * 把 migration 列表按顺序应用；每条要么「已存在」（不动）要么整段包在事务里执行。
 * statements 内的语句应自包含；旧列兼容 / IF NOT EXISTS 都由 SQL 层保证幂等。
 */
export function applyMigrations(db: Database.Database, migrations: Migration[]): void {
  db.exec(`CREATE TABLE IF NOT EXISTS migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL)`);
  const applied = new Set(
    (db.prepare(`SELECT id FROM migrations`).all() as Array<{ id: string }>).map((r) => r.id),
  );
  const record = db.prepare(`INSERT INTO migrations(id, applied_at) VALUES(?, ?)`);
  for (const migration of migrations) {
    if (applied.has(migration.id)) continue;
    if (migration.statements.length) {
      const tx = db.transaction((statements: string[]) => {
        for (const stmt of statements) {
          try {
            db.exec(stmt);
          } catch (error) {
            // 已有列 / 已有索引 用「IF NOT EXISTS / 失败即视作已存在」兼容；
            // 任何异常都必须阻断剩余 migration 并回滚。
            const message = (error as { message?: string } | null)?.message || "";
            if (/duplicate column name|already exists/i.test(message)) continue;
            throw error;
          }
        }
      });
      tx(migration.statements);
    }
    record.run(migration.id, new Date().toISOString());
  }
}

/** 表是否包含某列（用于运行时迁移兼容旧 db 文件）。 */
export function hasColumn(db: Database.Database, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return rows.some((row) => row.name === column);
}
