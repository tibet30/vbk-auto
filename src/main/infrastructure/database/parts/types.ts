/**
 * 数据库各模块共享的小工具。
 */

import { randomUUID } from "node:crypto";

/** 标准 ISO 时间字符串。 */
export const now = () => new Date().toISOString();

/**
 * 为新产品生成 VBK 内部 supplierProductCode。
 * 固定格式「VBK-{联系人名字}」；未提供联系人时回落到「VBK-YYYYMMDD-XXXXXX」
 * （日期戳 + uuid 前 6 位，同一秒内多次创建也不会冲突）。
 */
export function newSupplierProductCode(contactName?: string | null) {
  const name = typeof contactName === "string" ? contactName.trim() : "";
  if (name) return `VBK-${name}`;
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  return `VBK-${stamp}-${randomUUID().slice(0, 6).toUpperCase()}`;
}

/** 在 db 句柄上随机生成一个 uuid（SQLite 主键使用）。 */
export function newId() {
  return randomUUID();
}
