/**
 * SQLite 数据访问层（VbkDatabase facade）。
 *
 * 这是 main 进程与本地数据库交互的唯一入口；上层 IPC handler 只调本类方法，
 * 不直接写 SQL。表结构与迁移以 `runDatabaseMigrations()` 为准——新表/列需在这里添加。
 *
 * 主要能力（按职责分区到 parts/ 子模块）：
 *  - 项目 CRUD：listProjects / createProject / getProject / deleteProject / updateProduct…
 *  - 会话消息：addMessage / updateMessageStatus / recoverUnansweredMessages
 *  - 设置：getSetting / setSetting / deleteSetting
 *  - Research 任务：addResearchTask / markResearchAccepted
 *  - Automation Run：saveAutomation / recoverOrphanAutomationRuns
 *  - Planning 状态：loadPlanningState / savePlanningState / deletePlanningState / recoverOrphanPlanningStates
 *  - 多账号登录会话：saveSession / loadSession / listSessions / deleteSession / migratePlaintextCookiesToEncrypted
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
  CreateProjectInput,
  PlanningGenerationState,
  ProjectDetail,
  ProjectSummary,
  ResearchTask,
  SavedLoginAccount,
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
  addResearchTask,
  createProject,
  deleteProject,
  getProject,
  listProjects,
  markResearchAccepted,
  recoverOrphanAutomationRuns,
  recoverUnansweredMessages,
  saveAutomation,
  setBasicInfoSaved,
  setProductId,
  setProjectLifecycle,
  updateBasicInfoField,
  updateMessageStatus,
  updateProduct,
  writeAutomationWithProjectStatus,
} from "./parts/projects.js";
import {
  deleteSession,
  dropPlaintextCookiesColumn,
  listSessions,
  loadSession,
  migratePlaintextCookiesToEncrypted,
  saveSession,
  saveSessionPlain,
  type SessionRecord,
} from "./parts/sessions.js";
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
  // projects / messages / research_tasks / automation_runs
  // ─────────────────────────────────────────────────────────────────────

  listProjects(): ProjectSummary[] { return listProjects(this.db); }
  createProject(input: CreateProjectInput): ProjectDetail { return createProject(this.db, input); }
  getProject(id: string): ProjectDetail | undefined { return getProject(this.db, id); }
  deleteProject(id: string): boolean { return deleteProject(this.db, id); }
  updateProduct(id: string, product: Record<string, unknown>, status?: ProjectSummary["status"]) {
    updateProduct(this.db, id, product, status);
  }
  updateBasicInfoField(projectId: string, field: string, value: string): ProjectDetail {
    return updateBasicInfoField(this.db, projectId, field, value);
  }
  setProductId(projectId: string, productId: string) {
    setProductId(this.db, projectId, productId);
  }
  setBasicInfoSaved(projectId: string, saved = true) {
    setBasicInfoSaved(this.db, projectId, saved);
  }
  setProjectLifecycle(projectId: string, updates: { productId?: string; status?: ProjectSummary["status"]; basicInfoSaved?: boolean }): void {
    setProjectLifecycle(this.db, projectId, updates);
  }
  writeAutomationWithProjectStatus(projectId: string, run: AutomationRun, status: ProjectSummary["status"]): void {
    writeAutomationWithProjectStatus(this.db, projectId, run, status);
  }
  addMessage(projectId: string, role: ConversationMessage["role"], content: string, taskStatus?: ConversationMessage["taskStatus"]) {
    return addMessage(this.db, projectId, role, content, taskStatus);
  }
  updateMessageStatus(projectId: string, messageId: string, taskStatus: TaskStatus) {
    updateMessageStatus(this.db, projectId, messageId, taskStatus);
  }
  recoverUnansweredMessages() { recoverUnansweredMessages(this.db); }
  recoverOrphanAutomationRuns() { return recoverOrphanAutomationRuns(this.db); }
  addResearchTask(projectId: string, task: Pick<ResearchTask, "label" | "type" | "detail">) {
    return addResearchTask(this.db, projectId, task);
  }
  markResearchAccepted(projectId: string, taskId: string, note?: string, source: "vbk" | "web" | "user" = "user") {
    markResearchAccepted(this.db, projectId, taskId, note, source);
  }
  saveAutomation(projectId: string, run: AutomationRun) {
    saveAutomation(this.db, projectId, run);
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
  // login_sessions（多账号登录态）+ plaintext → encrypted 迁移
  // ─────────────────────────────────────────────────────────────────────

  saveSession(accountKey: string, accountName: string, cookiesCiphertext: string) {
    saveSession(this.db, accountKey, accountName, cookiesCiphertext);
  }
  saveSessionPlain(
    accountKey: string,
    accountName: string,
    cookiesPlaintext: string,
    encrypt: (plaintext: string) => Promise<string>,
  ): Promise<void> {
    return saveSessionPlain(this.db, accountKey, accountName, cookiesPlaintext, encrypt);
  }
  loadSession(accountKey: string): SessionRecord | null {
    return loadSession(this.db, accountKey);
  }
  listSessions(): SavedLoginAccount[] { return listSessions(this.db); }
  deleteSession(accountKey: string) { deleteSession(this.db, accountKey); }
  async migratePlaintextCookiesToEncrypted(encrypt: (plaintext: string) => Promise<string>): Promise<{ migrated: number; failed: number }> {
    return migratePlaintextCookiesToEncrypted(this.db, encrypt);
  }
  dropPlaintextCookiesColumn(): void {
    dropPlaintextCookiesColumn(this.db);
  }

  // ─────────────────────────────────────────────────────────────────────
  // planning_generation（持久化规划状态）
  // ─────────────────────────────────────────────────────────────────────

  loadPlanningState(projectId: string): PlanningGenerationState | undefined {
    return loadPlanningState(this.db, projectId);
  }
  savePlanningState(state: PlanningGenerationState): void {
    savePlanningState(this.db, state);
  }
  deletePlanningState(projectId: string): void {
    deletePlanningState(this.db, projectId);
  }
  recoverOrphanPlanningStates(): string[] {
    return recoverOrphanPlanningStates(this.db);
  }

  // ─────────────────────────────────────────────────────────────────────
  // operation_log（真实持久化 + 上限 1000 行）
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
