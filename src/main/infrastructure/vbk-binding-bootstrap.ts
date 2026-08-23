/**
 * Wires Tibet VBK binding remote + local sync into the main process lifecycle.
 * Cookies stay local; this module never uploads session material.
 */

import { logWarn } from "../../shared/log-timestamp.js";
import type { AppAuthUser } from "../../shared/contracts-auth.js";
import type { AppAuthStore } from "./app-auth-store.js";
import type { VbkDatabase } from "./database/database.js";
import { fixedInfoKey, isScopedFixedInfoKey } from "./database/fixed-info.js";
import { createTibetVbkBindingService } from "./tibet-vbk-bindings.js";
import { createVbkBindingSync, isVbkAccountKey, type VbkBindingSync } from "./vbk-binding-sync.js";
import type { LocalVbkCookieStore } from "./vbk-cookie-store.js";
import type { VbkBrowser } from "./vbk-browser.js";

export type VbkBindingAuthSource = "status" | "login" | "switchAccount";

export type VbkBindingBootstrap = {
  bindingSync: VbkBindingSync;
  getExtensionUserId: () => number | null;
  onAuthenticated: (user: AppAuthUser, source: VbkBindingAuthSource) => Promise<void>;
  afterBrowserReady: () => Promise<void>;
  /** Idempotent touchActive for switchAccount / first login snapshot. */
  noteVbkAccountActive: (
    accountKey: string,
    meta?: { accountName?: string; providerId?: number | null },
  ) => void;
};

export type BindingSyncSchedulerOpts = {
  forceSync?: boolean;
  forceRestore?: boolean;
};

/**
 * Serial sync queue for auth lifecycle. `forceSync` always runs a fresh sync for
 * that userId after prior work settles — overlapping status must not drop login/switch.
 */
export function createBindingSyncScheduler(deps: {
  syncFromRemote: (userId: number) => Promise<void>;
  restoreFromCache: (userId: number) => Promise<void>;
  onError?: (error: unknown) => void;
}) {
  let lastSyncedUserId: number | null = null;
  let chain: Promise<void> = Promise.resolve();

  return {
    getLastSyncedUserId: () => lastSyncedUserId,
    syncAndRestore(userId: number, opts?: BindingSyncSchedulerOpts): Promise<void> {
      const job = async () => {
        const needsSync = Boolean(opts?.forceSync) || lastSyncedUserId !== userId;
        if (!needsSync) {
          if (opts?.forceRestore) await deps.restoreFromCache(userId);
          return;
        }
        try {
          await deps.syncFromRemote(userId);
          lastSyncedUserId = userId;
        } catch (error) {
          deps.onError?.(error);
        }
      };
      const next = chain.then(job, job);
      chain = next.then(() => undefined, () => undefined);
      return next;
    },
  };
}

function listLegacyFixedInfoKeys(db: VbkDatabase): string[] {
  const keys: string[] = [];
  for (const { accountName } of db.listKnownAccounts()) {
    const name = accountName.trim();
    if (!name) continue;
    const settingKey = fixedInfoKey(name);
    if (isScopedFixedInfoKey(settingKey)) continue;
    if (!db.getSetting(settingKey)?.value) continue;
    keys.push(name);
  }
  return keys;
}

export function createVbkBindingBootstrap(deps: {
  appAuthStore: AppAuthStore;
  db: VbkDatabase;
  getCookieStore: () => LocalVbkCookieStore | null;
  getBrowser: () => VbkBrowser | null | undefined;
}): VbkBindingBootstrap {
  const { appAuthStore, db, getCookieStore, getBrowser } = deps;
  const remote = createTibetVbkBindingService(appAuthStore);
  const bindingSync = createVbkBindingSync({
    remote,
    db: {
      getSetting: (key) => db.getSetting(key)?.value,
      setSetting: (key, value) => db.setSetting(key, value),
      deleteSetting: (key) => db.deleteSetting(key),
    },
    listLegacyFixedInfoKeys: () => listLegacyFixedInfoKeys(db),
  });

  let lastTouchedAccountKey: string | null = null;

  const getExtensionUserId = () => appAuthStore.get()?.user.id ?? null;

  const restoreIfPossible = async (snapshot: Awaited<ReturnType<VbkBindingSync["syncFromRemote"]>>) => {
    const browser = getBrowser();
    const cookieStore = getCookieStore();
    if (!browser || !cookieStore) return;
    await bindingSync.restoreActiveVbk(
      snapshot,
      (key) => Boolean(cookieStore.loadSession(key)),
      (key) => browser.switchAccount(key),
    );
  };

  const restoreFromCachedSnapshot = async (userId: number) => {
    const cached = db.getSetting(`extensionVbkBindings:${userId}`)?.value;
    if (!cached) return;
    try {
      await restoreIfPossible(JSON.parse(cached));
    } catch (error) {
      logWarn("[vbk-binding] restore from cache failed", error);
    }
  };

  // Serialized queue: forceSync (login/switch) always runs after prior work — never dropped.
  const syncScheduler = createBindingSyncScheduler({
    syncFromRemote: async (userId) => {
      const snapshot = await bindingSync.syncFromRemote(userId);
      await restoreIfPossible(snapshot);
    },
    restoreFromCache: restoreFromCachedSnapshot,
    onError: (error) => logWarn("[vbk-binding] syncFromRemote failed", error),
  });

  const syncAndRestore = async (
    user: AppAuthUser,
    opts?: { forceSync?: boolean; forceRestore?: boolean },
  ) => {
    await syncScheduler.syncAndRestore(user.id, opts);
  };

  return {
    bindingSync,
    getExtensionUserId,
    async onAuthenticated(user, source) {
      if (source === "login" || source === "switchAccount") {
        lastTouchedAccountKey = null;
      }
      await syncAndRestore(user, {
        forceSync: source === "login" || source === "switchAccount",
      });
    },
    async afterBrowserReady() {
      const session = appAuthStore.get();
      if (!session?.user?.id) return;
      await syncAndRestore(session.user, { forceSync: true, forceRestore: true });
    },
    noteVbkAccountActive(accountKey, meta) {
      const key = accountKey.trim();
      // 拒绝展示名当主键（如「小璐」），避免污染 Tibet 绑定表。
      if (!isVbkAccountKey(key)) {
        logWarn("[vbk-binding] skip touchActive: accountKey is not vbk_login", { accountKey: key });
        return;
      }
      const userId = getExtensionUserId();
      if (userId == null) return;
      if (lastTouchedAccountKey === key) return;
      lastTouchedAccountKey = key;
      void bindingSync.touchActive(userId, key, meta).catch((error) => {
        logWarn("[vbk-binding] touchActive failed", { accountKey: key, error });
      });
    },
  };
}
