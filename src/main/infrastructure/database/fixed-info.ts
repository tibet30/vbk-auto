import type {
  AccountFixedInfo,
  AccountFixedInfoField,
  AccountFixedInfoFieldKey,
  AccountFixedInfoValue,
  ContactCardSelection,
} from "../../../shared/contracts.js";

type FixedInfoContext = {
  getSetting: (key: string) => string | undefined;
  setSetting: (key: string, value: string) => void;
  deleteSetting: (key: string) => void;
};

export const FIXED_INFO_FIELDS: AccountFixedInfoField[] = [
  { key: "servicePhone", label: "400 电话", placeholder: "请输入 400 电话号码", emptyText: "尚未设置", kind: "text" },
  { key: "butlerName", label: "管家联系人", placeholder: "点击右侧刷新从 VBK 拉取联系人", emptyText: "尚未选择", kind: "select" },
];

export function fixedInfoSchema(): AccountFixedInfoField[] {
  return FIXED_INFO_FIELDS.map((field) => ({ ...field }));
}

export function getAccountFixedInfo(context: FixedInfoContext, accountName: string): AccountFixedInfo {
  const key = fixedInfoKey(accountName);
  const row = context.getSetting(key);
  return decodeAccountFixedInfo(accountName, FIXED_INFO_FIELDS, row);
}

export function setAccountFixedInfo(
  context: FixedInfoContext,
  accountName: string,
  values: Partial<Record<AccountFixedInfoFieldKey, AccountFixedInfoValue | null>>,
): AccountFixedInfo {
  const current = decodeAccountFixedInfo(accountName, FIXED_INFO_FIELDS, context.getSetting(fixedInfoKey(accountName)));
  const merged: Partial<Record<AccountFixedInfoFieldKey, AccountFixedInfoValue>> = { ...current.values };
  for (const field of FIXED_INFO_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(values, field.key)) continue;
    const incoming = (values as Record<string, AccountFixedInfoValue | null | undefined>)[field.key];
    if (field.kind === "text") {
      const text = typeof incoming === "string" ? incoming.trim() : "";
      if (text) merged[field.key] = text;
      else delete merged[field.key];
    } else if (field.kind === "select") {
      if (incoming == null) {
        delete merged[field.key];
        continue;
      }
      if (!isContactCardSelection(incoming)) {
        throw new Error(`字段「${field.label}」必须是合法的联系人选择。`);
      }
      merged[field.key] = incoming;
    }
  }

  const key = fixedInfoKey(accountName);
  if (!merged || Object.keys(merged).length === 0) {
    // 没有保留任何字段时直接删 key，避免 settings 表里堆陈旧空对象。
    context.deleteSetting(key);
    return { accountName, values: {} };
  }
  context.setSetting(key, JSON.stringify(merged));
  return { accountName, values: merged };
}

function fixedInfoKey(accountName: string) {
  return `accountFixedInfo:${accountName}`;
}

function decodeAccountFixedInfo(
  accountName: string,
  fields: ReadonlyArray<AccountFixedInfoField>,
  raw: string | undefined,
): AccountFixedInfo {
  const values: Partial<Record<AccountFixedInfoFieldKey, AccountFixedInfoValue>> = {};
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        for (const field of fields) {
          const candidate = (parsed as Record<string, unknown>)[field.key];
          if (candidate == null) continue;
          if (field.kind === "text") {
            if (typeof candidate === "string" && candidate.trim()) values[field.key] = candidate.trim();
          } else if (field.kind === "select" && isContactCardSelection(candidate)) {
            values[field.key] = candidate;
          }
        }
      }
    } catch {
      // 历史脏数据保留现状但不抛错，让运营能继续录入覆盖。
    }
  }
  return { accountName, values };
}

function isContactCardSelection(value: unknown): value is ContactCardSelection {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Number.isInteger(record.contactCardId) && Number.isInteger(record.providerId) && typeof record.displayName === "string" && record.displayName.trim().length > 0;
}
