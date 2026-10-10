/**
 * VbkDatabase operation log + 列存在性 helper 部分：
 *   - OPERATION_LOG_CAP 静态字段（默认上限 10000 行）
 *   - appendOperationLog / countOperationLog / queryOperationLog /
 *     recoverOrphanOperationLog
 *   - hasColumn：表是否包含某列（用于运行时迁移兼容旧 db 文件）
 *
 * 实现策略：方法集合对象 + static 对象；database.ts 用 Object.assign 合并。
 */

import type Database from "better-sqlite3";
import { hasColumn } from "../parts/migrations.js";
import {
  OPERATION_LOG_CAP,
  appendOperationLog,
  countOperationLog,
  queryOperationLog,
  recoverOrphanOperationLog,
  type OperationLogRow,
} from "../parts/operation-log.js";

export const operationLogMethods = {
  appendOperationLog(this: { db: Database.Database }, entry: Record<string, unknown> & { id: string; type: string; name: string; status: string; startedAt: string }): void { appendOperationLog(this.db, entry); },
  countOperationLog(this: { db: Database.Database }): number { return countOperationLog(this.db); },
  queryOperationLog(this: { db: Database.Database }, query: Parameters<typeof queryOperationLog>[1]): Array<OperationLogRow> { return queryOperationLog(this.db, query); },
  recoverOrphanOperationLog(this: { db: Database.Database }): number { return recoverOrphanOperationLog(this.db); },
  hasColumn(this: { db: Database.Database }, table: string, column: string): boolean { return hasColumn(this.db, table, column); },
} as const;

export const operationLogStatics = {
  OPERATION_LOG_CAP,
} as const;