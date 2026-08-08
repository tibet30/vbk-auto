/**
 * 「账号固定信息」读写工具：
 *   - 数据按账号 id 缓存到 settings 表里，键 `accountFixedInfo:${accountName}`；
 *   - FIXED_INFO_FIELDS 定义可用字段，目前包含 servicePhone 与 butlerName；
 *   - 读 getAccountFixedInfo / 写 setAccountFixedInfo 合并 + 类型校验；
 *   - 全部为空时直接删除设置项，避免 settings 表堆积空对象。
 */

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

/**
 * 返回一份字段定义的深拷贝（给 IPC / UI 用，避免上层修改原数组）。
 */
export function fixedInfoSchema(): AccountFixedInfoField[] {
  return FIXED_INFO_FIELDS.map((field) => ({ ...field }));
}

/**
 * 从 settings 表读账号固定信息 JSON；解析失败或字段非法时回落到默认值（不抛错）。
 */
export function getAccountFixedInfo(context: FixedInfoContext, accountName: string): AccountFixedInfo {
  const key = fixedInfoKey(accountName);
  const row = context.getSetting(key);
  return decodeAccountFixedInfo(accountName, FIXED_INFO_FIELDS, row);
}

/**
 * 合并写入账号固定信息：
 *   - text 字段 trim 后空字符串视为删除；
 *   - select 字段必须通过 isContactCardSelection 校验；
 *   - 合并完成后若字段全空 → deleteSetting，否则 setSetting 写回。
 * 返回合并后的 AccountFixedInfo。
 */
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

/**
 * 生成账号固定信息在 settings 表里的键名（`accountFixedInfo:${accountName}`）。
 */
function fixedInfoKey(accountName: string) {
  return `accountFixedInfo:${accountName}`;
}

/**
 * 从 settings 表读出的 JSON 字符串反序列化成 AccountFixedInfo：
 *   - JSON.parse 失败时回落到空 values（旧脏数据保留可覆盖，不抛错）；
 *   - 字段类型不匹配 / select 字段不通过类型守卫时跳过。
 */
function decodeAccountFixedInfo(
  accountName: string,
  fields: readonly AccountFixedInfoField[],
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

/**
 * 类型守卫：判断一个对象是否是合法的 ContactCardSelection（contactCardId / providerId 都为正整数，
 * displayName 非空字符串）。用于 setAccountFixedInfo 的 select 字段校验与解码防脏数据。
 */
function isContactCardSelection(value: unknown): value is ContactCardSelection {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  const id = Number(candidate.contactCardId);
  const providerId = Number(candidate.providerId);
  const name = typeof candidate.displayName === "string" ? candidate.displayName.trim() : "";
  return Number.isInteger(id) && id > 0
    && Number.isInteger(providerId) && providerId > 0
    && name.length > 0;
}
