/**
 * Enrich VBK login status: persist account name, refresh providerId, save session.
 */

import { logWarn } from "../../shared/log-timestamp.js";
import type { VbkLoginStatus } from "../../shared/contracts.js";
import type { VbkDatabase } from "./database/database.js";
import { detectProviderIdFromBrowser, scheduleProviderIdRefresh } from "./provider-id-source.js";
import type { VbkBrowser } from "./vbk-browser.js";

export type NoteVbkAccountActive = (
  accountKey: string,
  meta?: { accountName?: string; providerId?: number | null },
) => void;

const providerIdRefreshing = new Set<string>();

export function createWithKnownVbkAccount(deps: {
  db: VbkDatabase;
  getBrowser: () => VbkBrowser | null | undefined;
  noteVbkAccountActive: NoteVbkAccountActive;
}): (status: VbkLoginStatus) => VbkLoginStatus {
  const { db, getBrowser, noteVbkAccountActive } = deps;
  return (status) => {
    if (!status.loggedIn) return status;
    // Prefer last local name when page scrape misses; never invent a fixed fallback.
    const accountName = status.accountName || db.getSetting("vbkAccountName")?.value || "";
    if (accountName) {
      db.setSetting("vbkAccountName", accountName);
      if (!providerIdRefreshing.has(accountName)) {
        providerIdRefreshing.add(accountName);
        scheduleProviderIdRefresh(accountName, detectProviderIdFromBrowser, (id: number | null) => {
          db.setProviderIdFor(accountName, id);
          providerIdRefreshing.delete(accountName);
        });
      }
    }
    // Persist cookies asynchronously; failures only warn (status IPC must stay sync).
    const browser = getBrowser();
    if (accountName && browser) {
      browser.saveCurrentSession()
        .then((saved) => {
          if (!saved) return;
        db.setSetting("vbkActiveAccountKey", saved.accountKey);
        noteVbkAccountActive(saved.accountKey, {
            accountName: saved.accountName || accountName,
            // providerId 的缓存主键必须跟 VBK 登录账号一致；展示名只用于显示。
            providerId: db.providerIdFor(saved.accountKey)
              ?? db.providerIdFor(saved.accountName || accountName),
        });
        })
        .catch((error) => {
          logWarn("[vbk] saveCurrentSession failed; user must re-login", {
            message: (error as { message?: string })?.message ?? String(error),
          });
        });
    }
    const accounts = Array.from(new Set([...(status.accounts || []), accountName].filter(Boolean)));
    return { ...status, accountName, accounts };
  };
}
