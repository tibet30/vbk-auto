/**
 * VbkDatabase settings / provider accounts 部分：
 *   - getSetting / setSetting / deleteSetting
 *   - listLocalRejectedPresentationWords / listRejectedPresentationWords /
 *     recordCopyFeedback / getPresentationCopyRecovery /
 *     savePresentationCopyRecovery
 *   - getAccountFixedInfo（带 extensionUserId scope 解析） /
 *     setAccountFixedInfo / providerIdFor / setProviderIdFor /
 *     listKnownAccounts / fixedInfoSchema
 *
 * 实现策略：本文件把方法集中到一个对象，database.ts 用 Object.assign 合并
 * 到 VbkDatabase 类原型；不引入 declaration merging，避免类型噪音。
 */

import type {
  AccountFixedInfo,
  AccountFixedInfoField,
  AccountFixedInfoFieldKey,
  AccountFixedInfoValue,
} from "../../../../shared/contracts.js";
import type Database from "better-sqlite3";
import * as copyFeedback from "../parts/vbk-copy-feedback.js";
import { deleteSetting, getSetting, setSetting } from "../parts/settings.js";
import {
  fixedInfoSchema as partFixedInfoSchema,
  getAccountFixedInfo as partGetAccountFixedInfo,
  listKnownAccounts as partListKnownAccounts,
  providerIdFor as partProviderIdFor,
  setAccountFixedInfo as partSetAccountFixedInfo,
  setProviderIdFor as partSetProviderIdFor,
} from "../parts/provider-accounts.js";

/**
 * 在 `this` 上读取 `db` / `extensionUserIdResolver`，并把方法原型包装到方法集合。
 * 由 database.ts 在 VbkDatabase 类定义完成后用 Object.assign 合并。
 */
export const settingsMethods = {
  getSetting(this: { db: Database.Database }, key: string) { return getSetting(this.db, key); },
  listLocalRejectedPresentationWords(this: { db: Database.Database }) { return copyFeedback.listRejectedPresentationWords(this.db); },
  listRejectedPresentationWords(this: { db: Database.Database; extensionUserIdResolver?: (() => number | null) | null }) {
    return copyFeedback.listRejectedPresentationWords(this.db, this.extensionUserIdResolver?.());
  },
  recordCopyFeedback(this: { db: Database.Database }, entry: Parameters<typeof copyFeedback.recordCopyFeedback>[1]) { copyFeedback.recordCopyFeedback(this.db, entry); },
  getPresentationCopyRecovery(this: { db: Database.Database }, id: string) { return copyFeedback.getPresentationCopyRecovery(this.db, id); },
  savePresentationCopyRecovery(this: { db: Database.Database }, id: string, entry: Parameters<typeof copyFeedback.savePresentationCopyRecovery>[2]) { copyFeedback.savePresentationCopyRecovery(this.db, id, entry); },
  setSetting(this: { db: Database.Database }, key: string, value: string) { setSetting(this.db, key, value); },
  deleteSetting(this: { db: Database.Database }, key: string) { deleteSetting(this.db, key); },
  getAccountFixedInfo(this: { db: Database.Database; extensionUserIdResolver?: (() => number | null) | null }, accountName: string): AccountFixedInfo {
    const name = accountName.trim();
    const userId = this.extensionUserIdResolver?.() ?? null;
    // Logged-in Tibet user: scoped cache only — no legacy fallback (cross-user bleed).
    if (userId != null && name) {
      const scoped = partGetAccountFixedInfo(this.db, `${userId}:${name}`);
      return { accountName: name, values: scoped.values };
    }
    return partGetAccountFixedInfo(this.db, accountName);
  },
  setAccountFixedInfo(this: { db: Database.Database }, accountName: string, values: Partial<Record<AccountFixedInfoFieldKey, AccountFixedInfoValue | null>>) { return partSetAccountFixedInfo(this.db, accountName, values); },
  providerIdFor(this: { db: Database.Database }, accountName: string): number | null { return partProviderIdFor(this.db, accountName); },
  setProviderIdFor(this: { db: Database.Database }, accountName: string, providerId: number | null) { partSetProviderIdFor(this.db, accountName, providerId); },
  listKnownAccounts(this: { db: Database.Database }) { return partListKnownAccounts(this.db); },
} as const;

export const settingsStatics = {
  fixedInfoSchema: (): AccountFixedInfoField[] => partFixedInfoSchema(),
} as const;