/**
 * settings 表的通用 KV 接口。供 provider-accounts / api-key / 多账号登录态等复用。
 */

import type Database from "better-sqlite3";

export function getSetting(db: Database.Database, key: string): { value: string } | undefined {
  return db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
}

export function setSetting(db: Database.Database, key: string, value: string): void {
  db.prepare("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, value);
}

export function deleteSetting(db: Database.Database, key: string): void {
  db.prepare("DELETE FROM settings WHERE key=?").run(key);
}
