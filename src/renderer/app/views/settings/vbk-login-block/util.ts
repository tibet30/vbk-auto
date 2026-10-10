/**
 * VBK 登录块纯函数 helper：
 *   - hasBindingValues：账号是否已绑定 400 电话 / 管家联系人；
 *   - resolveButlerDisplay：从 ContactCardSelection 派生展示名；
 *   - resolveFilledCount：根据 phone / butler 字符串派生「就绪度」。
 */

import type { AccountFixedInfo, ContactCardSelection } from "../../../../../shared/contracts.js";

export function hasBindingValues(info: AccountFixedInfo): boolean {
  const phone = typeof info.values.servicePhone === "string" ? info.values.servicePhone.trim() : "";
  const raw = info.values.butlerName;
  const butler = raw && typeof raw === "object" && "displayName" in raw
    ? String((raw as ContactCardSelection).displayName || "").trim()
    : "";
  return Boolean(phone || butler);
}

export function resolveButlerDisplay(raw: unknown): string {
  if (raw && typeof raw === "object" && "displayName" in raw) {
    return (raw as ContactCardSelection).displayName ?? "";
  }
  return "";
}

export function resolveFilledCount(phone: string, butler: string): number {
  return (phone ? 1 : 0) + (butler ? 1 : 0);
}

export type { AccountFixedInfo, ContactCardSelection };