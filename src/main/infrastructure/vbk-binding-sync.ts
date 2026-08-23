/**
 * Tibet VBK 绑定同步层：远端权威 + 本地 scoped 缓存 + 受限 legacy claim + dirty 冲突（remote wins）。
 *
 * 远端主键只接受 `vbk_*` loginAccount；展示名不得 upsert。
 * Legacy 认领整机只执行一次，且只上传合法 vbk_ 键，避免多应用账号互相拷贝。
 */

import type {
  AccountFixedInfo,
  AccountFixedInfoFieldKey,
  AccountFixedInfoValue,
  ContactCardSelection,
} from "../../shared/contracts.js";
import type {
  TibetVbkBindingService,
  VbkBinding,
  VbkBindingButler,
  VbkBindingUpsertPatch,
  VbkBindingsSnapshot,
} from "../../shared/contracts-vbk-binding.js";
import { getAccountFixedInfo, setAccountFixedInfo } from "./database/fixed-info.js";

type SettingsDb = {
  getSetting: (key: string) => string | undefined;
  setSetting: (key: string, value: string) => void;
  deleteSetting: (key: string) => void;
};

export type VbkBindingSyncDeps = {
  remote: TibetVbkBindingService;
  db: SettingsDb;
  /** 返回遗留 `accountFixedInfo:${accountKey}` 的 accountKey 列表（不含 userId 段）。 */
  listLegacyFixedInfoKeys?: () => string[];
  onRemoteWins?: (info: { accountKey: string }) => void;
};

/** 远端绑定主键：必须是 VBK loginAccount（vbk_xxx）。 */
export function isVbkAccountKey(value: unknown): value is string {
  return typeof value === "string" && /^vbk_[a-z0-9_-]+$/i.test(value.trim());
}

const LEGACY_CLAIM_DONE_KEY = "vbkBindingLegacyClaimDone";

export interface VbkBindingSync {
  syncFromRemote(extensionUserId: number): Promise<VbkBindingsSnapshot>;
  getFixedInfo(extensionUserId: number | null, accountName: string): AccountFixedInfo;
  saveFixedInfo(
    extensionUserId: number | null,
    accountKey: string,
    values: Partial<Record<AccountFixedInfoFieldKey, AccountFixedInfoValue | null>>,
    meta?: { accountName?: string; providerId?: number | null },
  ): Promise<AccountFixedInfo>;
  touchActive(
    extensionUserId: number,
    accountKey: string,
    meta?: { accountName?: string; providerId?: number | null },
  ): Promise<void>;
  restoreActiveVbk(
    snapshot: VbkBindingsSnapshot,
    hasLocalSession: (key: string) => boolean,
    switchTo: (key: string) => Promise<void>,
  ): Promise<"switched" | "missing-cookies" | "none">;
}

function snapshotCacheKey(extensionUserId: number) {
  return `extensionVbkBindings:${extensionUserId}`;
}

function dirtyKey(extensionUserId: number, accountKey: string) {
  return `accountFixedInfoDirty:${extensionUserId}:${accountKey}`;
}

function dirtyIndexKey(extensionUserId: number) {
  return `accountFixedInfoDirtyIndex:${extensionUserId}`;
}

function storageSuffix(extensionUserId: number, accountKey: string) {
  return `${extensionUserId}:${accountKey}`;
}

function readDirtyIndex(db: SettingsDb, extensionUserId: number): string[] {
  const raw = db.getSetting(dirtyIndexKey(extensionUserId));
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function writeDirtyIndex(db: SettingsDb, extensionUserId: number, keys: string[]) {
  const unique = [...new Set(keys.filter(Boolean))];
  if (unique.length === 0) db.deleteSetting(dirtyIndexKey(extensionUserId));
  else db.setSetting(dirtyIndexKey(extensionUserId), JSON.stringify(unique));
}

function hasValues(info: AccountFixedInfo): boolean {
  return Object.keys(info.values).length > 0;
}

function butlerOf(value: AccountFixedInfoValue | undefined): VbkBindingButler | null {
  if (!value || typeof value === "string") return null;
  const card = value as ContactCardSelection;
  return {
    contactCardId: card.contactCardId,
    displayName: card.displayName,
    providerId: card.providerId,
  };
}

function bindingToValues(binding: VbkBinding): Partial<Record<AccountFixedInfoFieldKey, AccountFixedInfoValue>> {
  const values: Partial<Record<AccountFixedInfoFieldKey, AccountFixedInfoValue>> = {};
  if (binding.servicePhone.trim()) values.servicePhone = binding.servicePhone.trim();
  if (binding.butler) values.butlerName = binding.butler;
  return values;
}

function fixedInfoToPatch(
  info: AccountFixedInfo,
  meta?: { accountName?: string; providerId?: number | null },
): VbkBindingUpsertPatch {
  const phone = info.values.servicePhone;
  return {
    vbkAccountName: meta?.accountName ?? info.accountName,
    ...(meta && Object.prototype.hasOwnProperty.call(meta, "providerId")
      ? { providerId: meta.providerId ?? null }
      : {}),
    servicePhone: typeof phone === "string" ? phone : "",
    butler: butlerOf(info.values.butlerName),
  };
}

/** 用远端绑定整表覆盖 scoped 缓存（非 merge，避免残留本地字段）。 */
function writeScopedFromBinding(db: SettingsDb, extensionUserId: number, binding: VbkBinding) {
  const values = bindingToValues(binding);
  const suffix = storageSuffix(extensionUserId, binding.vbkAccountKey);
  setAccountFixedInfo(db, suffix, {
    servicePhone: (values.servicePhone as string | undefined) ?? null,
    butlerName: (values.butlerName as ContactCardSelection | undefined) ?? null,
  });
}

function readScoped(db: SettingsDb, extensionUserId: number, accountKey: string): AccountFixedInfo {
  const raw = getAccountFixedInfo(db, storageSuffix(extensionUserId, accountKey));
  return { accountName: accountKey, values: raw.values };
}

function markDirty(db: SettingsDb, extensionUserId: number, accountKey: string) {
  db.setSetting(dirtyKey(extensionUserId, accountKey), new Date().toISOString());
  writeDirtyIndex(db, extensionUserId, [...readDirtyIndex(db, extensionUserId), accountKey]);
}

function clearDirty(db: SettingsDb, extensionUserId: number, accountKey: string) {
  db.deleteSetting(dirtyKey(extensionUserId, accountKey));
  writeDirtyIndex(
    db,
    extensionUserId,
    readDirtyIndex(db, extensionUserId).filter((key) => key !== accountKey),
  );
}

function writeSnapshot(db: SettingsDb, extensionUserId: number, snapshot: VbkBindingsSnapshot) {
  db.setSetting(snapshotCacheKey(extensionUserId), JSON.stringify(snapshot));
}

function collectDirtyKeys(db: SettingsDb, extensionUserId: number): string[] {
  return readDirtyIndex(db, extensionUserId).filter((accountKey) => Boolean(db.getSetting(dirtyKey(extensionUserId, accountKey))));
}

export function createVbkBindingSync(deps: VbkBindingSyncDeps): VbkBindingSync {
  const { remote, db, listLegacyFixedInfoKeys, onRemoteWins } = deps;

  /**
   * 整机只认领一次：仅上传合法 vbk_* legacy 键。已认领过的机器不再给后续空用户拷贝。
   */
  const claimLegacyOnce = async () => {
    if (db.getSetting(LEGACY_CLAIM_DONE_KEY)) return;
    const keys = (listLegacyFixedInfoKeys?.() ?? []).filter(isVbkAccountKey);
    for (const accountKey of keys) {
      const info = getAccountFixedInfo(db, accountKey);
      if (!hasValues(info)) continue;
      await remote.upsert(accountKey, fixedInfoToPatch({ accountName: accountKey, values: info.values }));
    }
    db.setSetting(LEGACY_CLAIM_DONE_KEY, new Date().toISOString());
  };

  const flushDirty = async (extensionUserId: number, snapshot: VbkBindingsSnapshot) => {
    const dirtyKeys = collectDirtyKeys(db, extensionUserId).filter(isVbkAccountKey);
    for (const accountKey of dirtyKeys) {
      const dirtyAtRaw = db.getSetting(dirtyKey(extensionUserId, accountKey));
      if (!dirtyAtRaw) continue;
      const remoteItem = snapshot.items.find((item) => item.vbkAccountKey === accountKey);
      const dirtyMs = Date.parse(dirtyAtRaw);
      const remoteMs = remoteItem?.updatedAt ? Date.parse(remoteItem.updatedAt) : NaN;
      if (remoteItem && Number.isFinite(remoteMs) && Number.isFinite(dirtyMs) && remoteMs > dirtyMs) {
        writeScopedFromBinding(db, extensionUserId, remoteItem);
        clearDirty(db, extensionUserId, accountKey);
        onRemoteWins?.({ accountKey });
        continue;
      }
      const local = readScoped(db, extensionUserId, accountKey);
      await remote.upsert(accountKey, fixedInfoToPatch(local, {
        accountName: remoteItem?.vbkAccountName ?? accountKey,
        providerId: remoteItem?.providerId,
      }));
      clearDirty(db, extensionUserId, accountKey);
    }
  };

  return {
    async syncFromRemote(extensionUserId) {
      let snapshot = await remote.list();
      if (snapshot.items.length === 0) {
        await claimLegacyOnce();
        snapshot = await remote.list();
      }
      await flushDirty(extensionUserId, snapshot);
      snapshot = await remote.list();
      writeSnapshot(db, extensionUserId, snapshot);
      for (const item of snapshot.items) {
        if (!isVbkAccountKey(item.vbkAccountKey)) continue;
        writeScopedFromBinding(db, extensionUserId, item);
      }
      return snapshot;
    },

    getFixedInfo(extensionUserId, accountName) {
      const key = accountName.trim();
      if (!key) return { accountName: "", values: {} };
      // With a Tibet user, only scoped cache — never legacy (prevents cross-user bleed).
      if (extensionUserId != null) return readScoped(db, extensionUserId, key);
      const legacy = getAccountFixedInfo(db, key);
      return { accountName: key, values: legacy.values };
    },

    async saveFixedInfo(extensionUserId, accountKey, values, meta) {
      const raw = accountKey.trim();
      if (!raw) return { accountName: "", values: {} };
      // 远端只认 vbk_*；展示名仅写本地，不 upsert，避免污染绑定表。
      const remoteKey = isVbkAccountKey(raw) ? raw : null;

      if (extensionUserId == null) {
        const saved = setAccountFixedInfo(db, raw, values);
        return { accountName: raw, values: saved.values };
      }

      const storageKey = remoteKey ?? raw;
      const saved = setAccountFixedInfo(db, storageSuffix(extensionUserId, storageKey), values);
      // UI 仍可能用展示名读：双写一份，避免「存了但设置页空白」。
      if (remoteKey && raw !== remoteKey) {
        setAccountFixedInfo(db, storageSuffix(extensionUserId, raw), values);
      }
      const info: AccountFixedInfo = { accountName: raw, values: saved.values };
      if (!remoteKey) return info;
      try {
        await remote.upsert(remoteKey, fixedInfoToPatch(info, {
          accountName: meta?.accountName ?? remoteKey,
          providerId: meta?.providerId,
        }));
        clearDirty(db, extensionUserId, remoteKey);
      } catch {
        markDirty(db, extensionUserId, remoteKey);
      }
      return info;
    },

    async touchActive(extensionUserId, accountKey, meta) {
      const key = accountKey.trim();
      if (!isVbkAccountKey(key)) return;
      // 兼容旧版本把展示名当 scoped key 写入的缓存。首次以真实
      // loginAccount 激活时迁移到 canonical key，避免丢失已有联系人/400。
      const canonical = readScoped(db, extensionUserId, key);
      const legacy = meta?.accountName?.trim() && meta.accountName.trim() !== key
        ? readScoped(db, extensionUserId, meta.accountName.trim())
        : { accountName: key, values: {} };
      const local = hasValues(canonical) ? canonical : legacy;
      if (!hasValues(canonical) && hasValues(legacy)) {
        setAccountFixedInfo(db, storageSuffix(extensionUserId, key), legacy.values);
      }
      const displayName = meta?.accountName?.trim() || key;
      await remote.upsert(key, fixedInfoToPatch(local, {
        accountName: displayName,
        providerId: meta?.providerId,
      }));
      await remote.activate(key);
      clearDirty(db, extensionUserId, key);
    },

    async restoreActiveVbk(snapshot, hasLocalSession, switchTo) {
      const key = snapshot.activeVbkAccountKey?.trim();
      if (!key) return "none";
      if (!hasLocalSession(key)) return "missing-cookies";
      await switchTo(key);
      return "switched";
    },
  };
}
