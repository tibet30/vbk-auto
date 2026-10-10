/**
 * SQLite 数据访问层（VbkDatabase facade）。
 *
 * 这是 main 进程与本地数据库交互的唯一入口；上层 IPC handler 只调本类方法，
 * 不直接写 SQL。表结构与迁移以 `runDatabaseMigrations()` 为准——新表/列需在这里添加。
 *
 * 主要能力（按职责分区到 database/ 子模块）：
 *  - 产品 CRUD（products.ts）
 *  - 会话消息（products.ts）
 *  - 设置 / 复制反馈（settings.ts）
 *  - Research 任务（products.ts）
 *  - Automation Run（products.ts）
 *  - Workflow 任务（agent.ts）
 *  - Planning 状态（agent.ts）
 *  - Agent Snapshot（agent.ts）
 *  - Provider ID 缓存 / 多账号 fixedInfo（settings.ts）
 *  - User memory（memory.ts）
 *  - 操作日志（operation-log.ts）
 *
 * 启动只做 `runDatabaseMigrations()` 建表 + 列变更；任何写入都直接满足当前 schema。
 *
 * 子文件方法集合通过 `Object.assign(VbkDatabase.prototype, ...)` 在类声明
 * 完成后挂载到原型；static 字段同样挂载到类上。
 */

import { LocalProductDatabase } from "./local-product-database.js";
import { productMethods } from "./database/products.js";
import { settingsMethods, settingsStatics } from "./database/settings.js";
import { agentMethods } from "./database/agent.js";
import { memoryMethods } from "./database/memory.js";
import { operationLogMethods, operationLogStatics } from "./database/operation-log.js";
import type { VbkDatabasePrototype } from "./database/types.js";
import type { AccountFixedInfoField } from "../../../shared/contracts.js";

/**
 * SQLite 数据访问对象，main 进程与本地数据库的唯一入口。
 *
 * 实现策略：所有 SQL 都委托给 parts/ 子模块；本类仅做"对外统一 facade"
 * ——保持 VbkDatabase.method() 调用形态不变，避免修改 IPC handler / 测试。
 */
export class VbkDatabase extends LocalProductDatabase {
  /** Optional Tibet extension user id for scoped accountFixedInfo reads. */
  extensionUserIdResolver: (() => number | null) | null = null;

  setExtensionUserIdResolver(resolver: (() => number | null) | null): void {
    this.extensionUserIdResolver = resolver;
  }
}

// 同名 interface 声明合并 ——把原型方法（Object.assign 运行时挂载）注册进类型。
// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export interface VbkDatabase extends VbkDatabasePrototype {}
export namespace VbkDatabase {
  export declare const OPERATION_LOG_CAP: number;
  export declare function fixedInfoSchema(): AccountFixedInfoField[];
}

// 把分散在各子文件的方法集合挂到类原型 + 类本身。
Object.assign(VbkDatabase.prototype, settingsMethods);
Object.assign(VbkDatabase.prototype, productMethods);
Object.assign(VbkDatabase.prototype, agentMethods);
Object.assign(VbkDatabase.prototype, memoryMethods);
Object.assign(VbkDatabase.prototype, operationLogMethods);

Object.assign(VbkDatabase, settingsStatics);
Object.assign(VbkDatabase, operationLogStatics);