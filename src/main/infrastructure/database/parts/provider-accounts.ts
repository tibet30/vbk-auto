/**
 * 账号相关：当前 vbk 账号名、providerId 缓存、账号固定信息。
 *   - providerIdFor / setProviderIdFor / listKnownAccounts
 *   - getAccountFixedInfo / setAccountFixedInfo / fixedInfoSchema
 *
 * 全部基于 settings 表；调用方传入 db 句柄。
 */

import type Database from "better-sqlite3";
import type {
  AccountFixedInfo,
  AccountFixedInfoField,
  AccountFixedInfoFieldKey,
  AccountFixedInfoValue,
} from "../../../../shared/contracts.js";
import { fixedInfoSchema as fixedInfoSchemaFn, getAccountFixedInfo as getFixedInfo, setAccountFixedInfo as setFixedInfo } from "../fixed-info.js";

type GetSettingFn = (key: string) => string | undefined;
type SetSettingFn = (key: string, value: string) => void;
type DeleteSettingFn = (key: string) => void;

/**
 * 当前账号的 providerId（上次抓取）。未抓取过返回 null。
 * 注意只读取 `providerIdByAccount:<accountName>` 这类明确前缀的 key。
 */
export function providerIdFor(db: Database.Database, accountName: string): number | null {
  const name = (accountName || "").trim();
  if (!name) return null;
  const key = `providerIdByAccount:${name}`;
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
  const raw = row?.value;
  if (!raw) return null;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

export function setProviderIdFor(db: Database.Database, accountName: string, providerId: number | null): void {
  const name = (accountName || "").trim();
  if (!name) return;
  const key = `providerIdByAccount:${name}`;
  if (providerId == null || !Number.isInteger(providerId) || providerId <= 0) {
    db.prepare("DELETE FROM settings WHERE key=?").run(key);
    return;
  }
  const insert = db.prepare("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value");
  insert.run(key, String(providerId));
}

/**
 * 列出本机已登录过的 VBK 账号 + 上次抓到的 providerId。
 *  - 包含当前账号 + 所有曾保存过固定信息的账号 + 缓存过 providerId 的账号；
 *  - 不包含 settings 里随便一个同名 key，避免误把 providerId 当账号名泄露。
 */
export function listKnownAccounts(db: Database.Database): Array<{ accountName: string; providerId?: number }> {
  const rows = db.prepare(`
    SELECT DISTINCT key FROM settings
    WHERE key IN ('vbkAccountName', 'accountFixedInfo:placeholder')
      OR key LIKE 'accountFixedInfo:%'
      OR key LIKE 'providerIdByAccount:%'
  `).all() as Array<{ key: string }>;
  const names = new Set<string>();
  const currentRow = db.prepare("SELECT value FROM settings WHERE key='vbkAccountName'").get() as { value: string } | undefined;
  const current = currentRow?.value;
  if (current) names.add(current);
  for (const row of rows) {
    if (row.key === "vbkAccountName") {
      const v = (db.prepare("SELECT value FROM settings WHERE key=?").get(row.key) as { value: string } | undefined)?.value;
      if (v) names.add(v);
    }
    if (row.key.startsWith("accountFixedInfo:")) names.add(row.key.slice("accountFixedInfo:".length));
    if (row.key.startsWith("providerIdByAccount:")) names.add(row.key.slice("providerIdByAccount:".length));
  }
  return Array.from(names).filter(Boolean).sort().map((accountName) => {
    const pid = providerIdFor(db, accountName);
    return pid ? { accountName, providerId: pid } : { accountName };
  });
}

/** 暴露 fixed-info schema（IPC 层取）。 */
export function fixedInfoSchema(): AccountFixedInfoField[] {
  return fixedInfoSchemaFn();
}

export function getAccountFixedInfo(db: Database.Database, accountName: string): AccountFixedInfo {
  const getSetting: GetSettingFn = (key) => (db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined)?.value;
  const setSetting: SetSettingFn = (key, value) => {
    db.prepare("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, value);
  };
  const deleteSetting: DeleteSettingFn = (key) => {
    db.prepare("DELETE FROM settings WHERE key=?").run(key);
  };
  return getFixedInfo({ getSetting, setSetting, deleteSetting }, accountName);
}

export function setAccountFixedInfo(
  db: Database.Database,
  accountName: string,
  values: Partial<Record<AccountFixedInfoFieldKey, AccountFixedInfoValue | null>>,
): AccountFixedInfo {
  const getSetting: GetSettingFn = (key) => (db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined)?.value;
  const setSetting: SetSettingFn = (key, value) => {
    db.prepare("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, value);
  };
  const deleteSetting: DeleteSettingFn = (key) => {
    db.prepare("DELETE FROM settings WHERE key=?").run(key);
  };
  return setFixedInfo({ getSetting, setSetting, deleteSetting }, accountName, values);
}
