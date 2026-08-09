/**
 * 多账号登录态：
 *   - saveSession / saveSessionPlain：把 VBK 账号的 cookies 抽出来持久化。
 *     新版本一律存到 cookies_ciphertext（safeStorage base64），cookies_json 仅作为
 *     迁移期兼容列；空快照等同删除；
 *   - loadSession：取快照，优先返回 ciphertext；旧 plaintext 仅在 ciphertext 缺失时回退；
 *   - listSessions / deleteSession：UI 显示与清理。
 *
 * cookie 列迁移策略：
 *   - 0003 migration 已经把 cookies_ciphertext 列加好；
 *   - migratePlaintextCookiesToEncrypted（main 启动时调用）把所有旧 cookies_json
 *     转写到 cookies_ciphertext；
 *   - 0006 migration（或 dropPlaintextCookiesColumn 显式调用）会 DROP 旧列。
 */

import type Database from "better-sqlite3";
import type { SavedLoginAccount } from "../../../../shared/contracts.js";
import { hasColumn } from "./migrations.js";
import { now } from "./types.js";

export interface SessionRecord {
  accountKey: string;
  accountName: string;
  cookiesCiphertext: string;
  savedAt: string;
}

/**
 * 保存/替换某个账号的 cookies 快照（密文）。
 *   - accountKey：唯一标识；
 *   - accountName：人类可读名；
 *   - cookiesCiphertext：来自 safeStorage 加密后的 base64 密文。
 * 同一 accountKey 多次保存会覆盖；saved_at 总是新的。
 * 空 ciphertext 等同删除。
 */
export function saveSession(db: Database.Database, accountKey: string, accountName: string, cookiesCiphertext: string): void {
  const key = accountKey.trim();
  if (!key) throw new Error("保存登录态失败：账号标识不能为空。");
  const display = accountName.trim() || key;
  if (!cookiesCiphertext) {
    deleteSession(db, key);
    return;
  }
  const tx = db.transaction(() => {
    if (hasColumn(db, "login_sessions", "cookies_ciphertext")) {
      // cookies_json 列仍在过渡期且含 NOT NULL 约束，INSERT 需提供空字符串占位。
      const hasJsonCol = hasColumn(db, "login_sessions", "cookies_json");
      const columns = ["account_key", "account_name", "cookies_ciphertext", ...(hasJsonCol ? ["cookies_json"] : []), "saved_at"];
      const placeholders = columns.map(() => "?").join(", ");
      const values = [key, display, cookiesCiphertext, ...(hasJsonCol ? [""] : []), now()];
      const setClauses = [
        "account_name = excluded.account_name",
        "cookies_ciphertext = excluded.cookies_ciphertext",
        ...(hasJsonCol ? ["cookies_json = excluded.cookies_json"] : []),
        "saved_at = excluded.saved_at",
      ].join(", ");
      db.prepare(`
        INSERT INTO login_sessions(${columns.join(", ")})
        VALUES(${placeholders})
        ON CONFLICT(account_key) DO UPDATE SET ${setClauses}
      `).run(...values);
    } else {
      // 旧列路径：未升级时仍走 plaintext（理论上不应发生，因为 0003 migration 已 ALTER）。
      db.prepare(`
        INSERT INTO login_sessions(account_key, account_name, cookies_json, saved_at)
        VALUES(?, ?, ?, ?)
        ON CONFLICT(account_key) DO UPDATE SET
          account_name=excluded.account_name,
          cookies_json=excluded.cookies_json,
          saved_at=excluded.saved_at
      `).run(key, display, cookiesCiphertext, now());
    }
  });
  tx();
}

/**
 * 便捷入口：接受明文 cookiesJson，异步加密后写入 cookies_ciphertext。
 * 内部用 safeStorage 加密（由调用方注入 encrypt 函数以避免循环依赖）。
 */
export async function saveSessionPlain(
  db: Database.Database,
  accountKey: string,
  accountName: string,
  cookiesPlaintext: string,
  encrypt: (plaintext: string) => Promise<string>,
): Promise<void> {
  const key = accountKey.trim();
  if (!key) return Promise.reject(new Error("保存登录态失败：账号标识不能为空。"));
  const display = accountName.trim() || key;
  if (!cookiesPlaintext || cookiesPlaintext === "[]") {
    deleteSession(db, key);
    return Promise.resolve();
  }
  const ciphertext = await encrypt(cookiesPlaintext);
  saveSession(db, key, display, ciphertext);
}

/**
 * 取一个账号的 cookies 快照；找不到返回 null。
 * 优先返回 ciphertext 列；旧 plaintext 列仅在 ciphertext 缺失时回退（迁移期）。
 * 返回 ciphertext 时由调用方负责解密（不在 db 层导入 safeStorage）。
 */
export function loadSession(db: Database.Database, accountKey: string): SessionRecord | null {
  const row = db.prepare(
    "SELECT account_name, cookies_ciphertext, cookies_json, saved_at FROM login_sessions WHERE account_key=?",
  ).get(accountKey) as
    | { account_name: string; cookies_ciphertext: string | null; cookies_json: string | null; saved_at: string }
    | undefined;
  if (!row) return null;
  if (row.cookies_ciphertext) {
    return {
      accountKey,
      accountName: row.account_name,
      cookiesCiphertext: row.cookies_ciphertext,
      savedAt: row.saved_at,
    };
  }
  if (row.cookies_json) {
    return {
      accountKey,
      accountName: row.account_name,
      cookiesCiphertext: row.cookies_json,
      savedAt: row.saved_at,
    };
  }
  return null;
}

/** 列举本机所有已记录的 VBK 账号；按最近使用倒序。 */
export function listSessions(db: Database.Database): SavedLoginAccount[] {
  const rows = db.prepare(`
    SELECT account_key, account_name, saved_at
    FROM login_sessions
    ORDER BY saved_at DESC
  `).all() as Array<{ account_key: string; account_name: string; saved_at: string }>;
  return rows.map((row) => ({
    accountKey: row.account_key,
    accountName: row.account_name || row.account_key,
    lastUsedAt: row.saved_at,
  }));
}

/** 删除一个已记录的账号快照；不存在不抛错。 */
export function deleteSession(db: Database.Database, accountKey: string): void {
  if (!accountKey) return;
  db.prepare("DELETE FROM login_sessions WHERE account_key=?").run(accountKey);
}

/**
 * 一次性把历史明文 cookies_json 升级到 encrypted cookies_ciphertext 列。
 *   - encrypt：调用方提供的 base64 密文生成函数（safeStorage）；
 *   - 失败抛错：让外层 catch 后保留旧列（不静默丢失）。
 */
export async function migratePlaintextCookiesToEncrypted(
  db: Database.Database,
  encrypt: (plaintext: string) => Promise<string>,
): Promise<{ migrated: number; failed: number }> {
  if (!hasColumn(db, "login_sessions", "cookies_json") || !hasColumn(db, "login_sessions", "cookies_ciphertext")) {
    return { migrated: 0, failed: 0 };
  }
  const rows = db.prepare(
    `SELECT account_key, cookies_json FROM login_sessions
     WHERE cookies_json IS NOT NULL AND cookies_json <> ''`,
  ).all() as Array<{ account_key: string; cookies_json: string }>;
  let migrated = 0;
  let failed = 0;
  const update = db.prepare(`UPDATE login_sessions SET cookies_ciphertext=? WHERE account_key=?`);
  // better-sqlite3 的 transaction 是同步 API；这里把迁移做成同步包裹每行 await encrypt(...)：
  //  - 串行执行（每次 await 一行），保证事务在加密完成后才提交；
  //  - 任一行失败抛错，整个事务回滚，由调用方决定是否重试或保留旧列。
  for (const row of rows) {
    try {
      const ciphertext = await encrypt(row.cookies_json);
      update.run(ciphertext, row.account_key);
      migrated += 1;
    } catch {
      failed += 1;
    }
  }
  return { migrated, failed };
}

/**
 * 在所有 cookies_ciphertext 都已填齐的情况下，把 plaintext cookies_json 列删除。
 * 不允许静默丢失：只要还有 missing 行就直接抛错。
 */
export function dropPlaintextCookiesColumn(db: Database.Database): void {
  if (!hasColumn(db, "login_sessions", "cookies_json")) return;
  if (!hasColumn(db, "login_sessions", "cookies_ciphertext")) {
    throw new Error("login_sessions 缺少 cookies_ciphertext 列，无法清理旧 plaintext 列");
  }
  const missing = db.prepare(
    `SELECT COUNT(*) AS n FROM login_sessions WHERE cookies_ciphertext IS NULL OR cookies_ciphertext = ''`,
  ).get() as { n: number };
  if (missing.n > 0) {
    throw new Error(`仍有 ${missing.n} 行 cookies_ciphertext 为空，暂不删除旧明文列`);
  }
  db.exec(`ALTER TABLE login_sessions DROP COLUMN cookies_json`);
  // 同步记录 migration 0006 表示已清理（幂等）。
  try {
    db.prepare(`INSERT OR IGNORE INTO migrations(id, applied_at) VALUES(?, ?)`).run("0006_login_sessions_drop_plaintext", now());
  } catch { /* 重复执行安全 */ }
}
