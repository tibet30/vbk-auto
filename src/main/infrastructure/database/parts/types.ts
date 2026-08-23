/**
 * 数据库各模块共享的小工具。
 */

import { randomUUID } from "node:crypto";

/** 标准 ISO 时间字符串。 */
export const now = () => new Date().toISOString();

let lastSupplierProductCodeStamp = "";
let supplierProductCodeSequence = 0;

function supplierProductCodeTimeStamp() {
  const stamp = new Date().toISOString().replace(/\D/g, "").slice(0, 17);
  if (stamp === lastSupplierProductCodeStamp) {
    supplierProductCodeSequence += 1;
  } else {
    lastSupplierProductCodeStamp = stamp;
    supplierProductCodeSequence = 0;
  }
  return supplierProductCodeSequence === 0
    ? stamp
    : `${stamp}${String(supplierProductCodeSequence).padStart(2, "0")}`;
}

/**
 * 为新产品生成 VBK 内部 supplierProductCode。
 * 有联系人时固定格式「VBK-{联系人名字}-{时间戳}」；未提供联系人时回落到
 * 「VBK-YYYYMMDD-XXXXXX」（日期戳 + uuid 前 6 位）。
 */
export function newSupplierProductCode(contactName?: string | null) {
  const name = typeof contactName === "string" ? contactName.trim() : "";
  if (name) return `VBK-${name}-${supplierProductCodeTimeStamp()}`;
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  return `VBK-${stamp}-${randomUUID().slice(0, 6).toUpperCase()}`;
}

/** 在 db 句柄上随机生成一个 uuid（SQLite 主键使用）。 */
export function newId() {
  return randomUUID();
}
