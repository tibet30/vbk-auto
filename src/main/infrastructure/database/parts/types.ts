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
 * basic 实际写入平台前生成供应商产品编号的时间部分。
 * 调用方已取得联系人后才允许调用，产品壳阶段不得调用。
 */
export function newSupplierProductCode(contactName: string) {
  return `VBK-${contactName.trim()}-${supplierProductCodeTimeStamp()}`;
}

/** 在 db 句柄上随机生成一个 uuid（SQLite 主键使用）。 */
export function newId() {
  return randomUUID();
}
