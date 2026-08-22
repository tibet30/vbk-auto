/**
 * SQLite 数据访问层（VbkDatabase facade）。
 *
 * 这是 main 进程与本地数据库交互的唯一入口；上层 IPC handler 只调本类方法，
 * 不直接写 SQL。表结构与迁移以 `runDatabaseMigrations()` 为准——新表/列需在这里添加。
 *
 * 主要能力（按职责分区到 parts/ 子模块）：
 *  - 产品 CRUD：listProducts / createProduct / getProduct / deleteProduct / updateProduct…
 *  - 会话消息：addMessage / updateMessageStatus / recoverUnansweredMessages
 *  - 设置：getSetting / setSetting / deleteSetting
 *  - Research 任务：addResearchTask / markResearchAccepted / markResearchTasksSatisfied
 *  - Automation Run：saveAutomation / recoverOrphanAutomationRuns
 *  - Planning 状态：loadPlanningState / savePlanningState / deletePlanningState / recoverOrphanPlanningStates
 *  - Provider ID 缓存：providerIdFor / setProviderIdFor / listKnownAccounts
 *  - 操作日志：appendOperationLog / queryOperationLog / countOperationLog / recoverOrphanOperationLog
 *
 * 启动只做 `runDatabaseMigrations()` 建表 + 列变更；任何写入都直接满足当前 schema。
 */

import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

import type {
  AccountFixedInfo,
  AccountFixedInfoField,
  AccountFixedInfoFieldKey,
  AccountFixedInfoValue,
  AutomationRun,
  ConversationMessage,
  CreateProductInput,
  PlanningGenerationState,
  ProductDetail,
  ProductSummary,
  ResearchTask,
  TaskStatus,
} from "../../../shared/contracts.js";

import { OPERATION_LOG_CAP, appendOperationLog, countOperationLog, queryOperationLog, recoverOrphanOperationLog, type OperationLogRow } from "./parts/operation-log.js";
import { deletePlanningState, loadPlanningState, recoverOrphanPlanningStates, savePlanningState } from "./parts/planning-state.js";
import { runDatabaseMigrations } from "./parts/migration-registry.js";
import { hasColumn } from "./parts/migrations.js";
import {
  fixedInfoSchema as partFixedInfoSchema,
  getAccountFixedInfo as partGetAccountFixedInfo,
  listKnownAccounts as partListKnownAccounts,
  providerIdFor as partProviderIdFor,
  setAccountFixedInfo as partSetAccountFixedInfo,
  setProviderIdFor as partSetProviderIdFor,
} from "./parts/provider-accounts.js";
import {
  addMessage,
  createProduct,
  deleteProduct,
  getProduct,
  importProductSnapshot,
  listProducts,
  listProductsPaginated,
  type ProductListPage,
  recoverOrphanAutomationRuns,
  recoverUnansweredMessages,
  saveAutomation,
  setBasicInfoSaved,
  setProductId,
  setProductLifecycle,
  updateBasicInfoField,
  updateMessageStatus,
  updateProduct,
  writeAutomationWithProductStatus,
} from "./parts/products.js";
import { buildProductSnapshot } from "./parts/product-draft.js";
import {
  replaceProductAndSatisfyResearchTasks,
  type ReplaceProductAndSatisfyResearchTasksOptions,
} from "./parts/replace-product-with-research-tasks.js";
import { addResearchTask, markResearchAccepted, markResearchTasksSatisfied } from "./parts/research-tasks.js";
import { deleteSetting, getSetting, setSetting } from "./parts/settings.js";

/**
 * SQLite 数据访问对象，main 进程与本地数据库的唯一入口。
 *
 * 实现策略：所有 SQL 都委托给 parts/ 子模块；本类仅做"对外统一 facade"
 * ——保持 VbkDatabase.method() 调用形态不变，避免修改 IPC handler / 测试。
 */
export class VbkDatabase {
  private db: Database.Database;

  constructor(dataPath: string) {
    fs.mkdirSync(dataPath, { recursive: true });
    this.db = new Database(path.join(dataPath, "vbk-desktop.sqlite"));
    this.db.pragma("journal_mode = WAL");
    runDatabaseMigrations(this.db);
  }

  // ─────────────────────────────────────────────────────────────────────
  // settings 表（KV）
  // ─────────────────────────────────────────────────────────────────────

  getSetting(key: string) {
    return getSetting(this.db, key);
  }
  setSetting(key: string, value: string) {
    setSetting(this.db, key, value);
  }
  /** 多账号登录态当前活跃指示器需要显式删除空字符串；现有 getSetting 接口无法区分"未设置"与"空"。 */
  deleteSetting(key: string) {
    deleteSetting(this.db, key);
  }

  // ─────────────────────────────────────────────────────────────────────
  // products / messages / research_tasks / automation_runs
  // ─────────────────────────────────────────────────────────────────────

  listProducts(): ProductSummary[] { return listProducts(this.db); }
  listProductsPaginated(page: number, pageSize?: number): ProductListPage { return listProductsPaginated(this.db, page, pageSize); }
  createProduct(input: CreateProductInput): ProductDetail { return createProduct(this.db, input); }
  buildProductSnapshot(input: CreateProductInput, supplierContactName?: string | null): ProductDetail { return buildProductSnapshot(input, supplierContactName); }
  getProduct(id: string): ProductDetail | undefined { return getProduct(this.db, id); }
  importProductSnapshot(snapshot: ProductDetail): ProductDetail { return importProductSnapshot(this.db, snapshot); }
  deleteProduct(id: string): boolean { return deleteProduct(this.db, id); }
  updateProduct(id: string, product: Record<string, unknown>, status?: ProductSummary["status"]) {
    updateProduct(this.db, id, product, status);
  }
  /**
   * 原子地「写产品 JSON + 按字段匹配确认 research task」。仅用于手工复核路径
   * （products:updateReviewField）；AI / 自动化 / 规划路径仍走 productMutations。
   * 详见 parts/products.ts 注释。
   */
  replaceProductAndSatisfyResearchTasks(
    localProductId: string,
    product: Record<string, unknown>,
    options?: ReplaceProductAndSatisfyResearchTasksOptions,
  ): { product: ProductDetail; confirmedTaskIds: string[] } {
    return replaceProductAndSatisfyResearchTasks(this.db, localProductId, product, options);
  }
  updateBasicInfoField(localProductId: string, field: string, value: string): ProductDetail {
    return updateBasicInfoField(this.db, localProductId, field, value);
  }
  setProductId(localProductId: string, productId: string) {
    setProductId(this.db, localProductId, productId);
  }
  setBasicInfoSaved(localProductId: string, saved = true) {
    setBasicInfoSaved(this.db, localProductId, saved);
  }
  setProductLifecycle(localProductId: string, updates: { productId?: string; status?: ProductSummary["status"]; basicInfoSaved?: boolean }): void {
    setProductLifecycle(this.db, localProductId, updates);
  }
  writeAutomationWithProductStatus(localProductId: string, run: AutomationRun, status: ProductSummary["status"]): void {
    writeAutomationWithProductStatus(this.db, localProductId, run, status);
  }
  addMessage(localProductId: string, role: ConversationMessage["role"], content: string, taskStatus?: ConversationMessage["taskStatus"]) {
    return addMessage(this.db, localProductId, role, content, taskStatus);
  }
  updateMessageStatus(localProductId: string, messageId: string, taskStatus: TaskStatus) {
    updateMessageStatus(this.db, localProductId, messageId, taskStatus);
  }
  recoverUnansweredMessages() { recoverUnansweredMessages(this.db); }
  recoverOrphanAutomationRuns() { return recoverOrphanAutomationRuns(this.db); }
  addResearchTask(localProductId: string, task: Pick<ResearchTask, "label" | "type" | "detail">) {
    return addResearchTask(this.db, localProductId, task);
  }
  markResearchAccepted(localProductId: string, taskId: string, note?: string, source: "vbk" | "web" | "user" = "user") {
    markResearchAccepted(this.db, localProductId, taskId, note, source);
  }
  markResearchTasksSatisfied(localProductId: string, taskIds: readonly string[], note?: string) {
    return markResearchTasksSatisfied(this.db, localProductId, taskIds, note);
  }
  saveAutomation(localProductId: string, run: AutomationRun) {
    saveAutomation(this.db, localProductId, run);
  }

  // ─────────────────────────────────────────────────────────────────────
  // account fixed info / providerId / known accounts
  // ─────────────────────────────────────────────────────────────────────

  static fixedInfoSchema(): AccountFixedInfoField[] { return partFixedInfoSchema(); }
  getAccountFixedInfo(accountName: string): AccountFixedInfo { return partGetAccountFixedInfo(this.db, accountName); }
  setAccountFixedInfo(accountName: string, values: Partial<Record<AccountFixedInfoFieldKey, AccountFixedInfoValue | null>>): AccountFixedInfo {
    return partSetAccountFixedInfo(this.db, accountName, values);
  }
  providerIdFor(accountName: string): number | null { return partProviderIdFor(this.db, accountName); }
  setProviderIdFor(accountName: string, providerId: number | null) {
    partSetProviderIdFor(this.db, accountName, providerId);
  }
  listKnownAccounts(): Array<{ accountName: string; providerId?: number }> {
    return partListKnownAccounts(this.db);
  }

  // ─────────────────────────────────────────────────────────────────────
  // planning_generation（持久化规划状态）
  // ─────────────────────────────────────────────────────────────────────

  loadPlanningState(localProductId: string): PlanningGenerationState | undefined {
    return loadPlanningState(this.db, localProductId);
  }
  savePlanningState(state: PlanningGenerationState): void {
    savePlanningState(this.db, state);
  }
  deletePlanningState(localProductId: string): void {
    deletePlanningState(this.db, localProductId);
  }
  recoverOrphanPlanningStates(): string[] {
    return recoverOrphanPlanningStates(this.db);
  }

  // ─────────────────────────────────────────────────────────────────────
  // operation_log（真实持久化 + 上限 10000 行）
  // ─────────────────────────────────────────────────────────────────────

  /** 操作日志默认上限：超过则按时间最早删。 */
  static readonly OPERATION_LOG_CAP = OPERATION_LOG_CAP;

  appendOperationLog(entry: Record<string, unknown> & { id: string; type: string; name: string; status: string; startedAt: string }): void {
    appendOperationLog(this.db, entry);
  }
  countOperationLog(): number { return countOperationLog(this.db); }
  queryOperationLog(query: Parameters<typeof queryOperationLog>[1]): Array<OperationLogRow> {
    return queryOperationLog(this.db, query);
  }
  recoverOrphanOperationLog(): number {
    return recoverOrphanOperationLog(this.db);
  }

  // ─────────────────────────────────────────────────────────────────────
  // 列存在性 helper（公开给上层做迁移兼容判定；旧调用方仍在使用）
  // ─────────────────────────────────────────────────────────────────────

  /** 表是否包含某列（用于运行时迁移兼容旧 db 文件）。 */
  hasColumn(table: string, column: string): boolean {
    return hasColumn(this.db, table, column);
  }
}
