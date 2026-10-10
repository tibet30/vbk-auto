/**
 * VbkDatabase 方法签名集合（interface）。
 *
 * 由 database.ts 用 `class VbkDatabase implements VbkDatabasePrototype` 引入；
 * 各子文件的方法集合（settingsMethods / productMethods / ...）会通过
 * `Object.assign(VbkDatabase.prototype, ...)` 在运行时挂载到原型上。
 *
 * 类型层面：把签名集中在 types.ts 让 TS 看到完整的方法表；运行时层面：
 * 实现放在子文件里，类 body 只保留公共成员（extensionUserIdResolver 等）。
 */

import type {
  AccountFixedInfo,
  AccountFixedInfoField,
  AccountFixedInfoFieldKey,
  AccountFixedInfoValue,
  AgentSnapshot,
  AutomationRun,
  ConversationMessage,
  CreateProductInput,
  MemoryFilter,
  MemoryInput,
  MemoryMaintenanceState,
  MemoryPatch,
  MemorySaveResult,
  PlanningGenerationState,
  ProductDetail,
  ProductSummary,
  ProductWorkflowTask,
  ResearchTask,
  TaskStatus,
  UserMemory,
  UserMemoryEvidence,
} from "../../../../shared/contracts.js";
import type { CachedCtripPoiAvailability } from "../parts/ctrip-poi-availability-cache.js";
import type { OperationLogRow } from "../parts/operation-log.js";
import type { ProductListPage } from "../parts/products.js";
import type { ReplaceProductAndSatisfyResearchTasksOptions } from "../parts/replace-product-with-research-tasks.js";

export interface VbkDatabasePrototype {
  // settings
  getSetting(key: string): ReturnType<typeof import("../parts/settings.js").getSetting>;
  listLocalRejectedPresentationWords(): ReturnType<typeof import("../parts/vbk-copy-feedback.js").listRejectedPresentationWords>;
  listRejectedPresentationWords(): ReturnType<typeof import("../parts/vbk-copy-feedback.js").listRejectedPresentationWords>;
  recordCopyFeedback(entry: Parameters<typeof import("../parts/vbk-copy-feedback.js").recordCopyFeedback>[1]): void;
  getPresentationCopyRecovery(id: string): ReturnType<typeof import("../parts/vbk-copy-feedback.js").getPresentationCopyRecovery>;
  savePresentationCopyRecovery(id: string, entry: Parameters<typeof import("../parts/vbk-copy-feedback.js").savePresentationCopyRecovery>[2]): void;
  setSetting(key: string, value: string): void;
  deleteSetting(key: string): void;
  getAccountFixedInfo(accountName: string): AccountFixedInfo;
  setAccountFixedInfo(accountName: string, values: Partial<Record<AccountFixedInfoFieldKey, AccountFixedInfoValue | null>>): AccountFixedInfo;
  providerIdFor(accountName: string): number | null;
  setProviderIdFor(accountName: string, providerId: number | null): void;
  listKnownAccounts(): Array<{ accountName: string; providerId?: number }>;

  // products / messages / research / automation
  listProducts(): ProductSummary[];
  listProductsPaginated(page: number, pageSize?: number): ProductListPage;
  createProduct(input: CreateProductInput): ProductDetail;
  buildProductSnapshot(input: CreateProductInput): ProductDetail;
  getProduct(id: string): ProductDetail | undefined;
  importProductSnapshot(snapshot: ProductDetail): ProductDetail;
  deleteProduct(id: string): boolean;
  updateProduct(id: string, product: Record<string, unknown>, status?: ProductSummary["status"], expectedVersion?: number): void;
  replaceProductAndSatisfyResearchTasks(localProductId: string, product: Record<string, unknown>, options?: ReplaceProductAndSatisfyResearchTasksOptions): { product: ProductDetail; confirmedTaskIds: string[] };
  updateBasicInfoField(localProductId: string, field: string, value: string): ProductDetail;
  setProductId(localProductId: string, productId: string): void;
  setBasicInfoSaved(localProductId: string, saved?: boolean): void;
  setProductLifecycle(localProductId: string, updates: { productId?: string | null; status?: ProductSummary["status"]; basicInfoSaved?: boolean }): void;
  writeAutomationWithProductStatus(localProductId: string, run: AutomationRun, status: ProductSummary["status"]): void;
  addMessage(localProductId: string, role: ConversationMessage["role"], content: string, taskStatus?: ConversationMessage["taskStatus"]): ReturnType<typeof import("../parts/products.js").addMessage>;
  updateMessageStatus(localProductId: string, messageId: string, taskStatus: TaskStatus): void;
  recoverUnansweredMessages(): void;
  recoverOrphanAutomationRuns(): ReturnType<typeof import("../parts/products.js").recoverOrphanAutomationRuns>;
  addResearchTask(localProductId: string, task: Pick<ResearchTask, "label" | "type" | "detail">): ReturnType<typeof import("../parts/research-tasks.js").addResearchTask>;
  markResearchAccepted(localProductId: string, taskId: string, note?: string, source?: "vbk" | "web" | "user"): void;
  markResearchTasksSatisfied(localProductId: string, taskIds: readonly string[], note?: string): ReturnType<typeof import("../parts/research-tasks.js").markResearchTasksSatisfied>;
  reopenKindSupersededPoiResearchTasks(localProductId: string, product: Record<string, unknown>): ReturnType<typeof import("../parts/research-tasks.js").reopenKindSupersededPoiResearchTasks>;
  markResearchTasksSatisfiedByProduct(localProductId: string, product: Record<string, unknown>): ReturnType<typeof import("../parts/research-tasks.js").markResearchTasksSatisfiedByProduct>;
  saveAutomation(localProductId: string, run: AutomationRun): void;

  // workflow / planning / agent snapshot
  createWorkflowTask(localProductId: string, productName: string): ProductWorkflowTask;
  completeWorkflowTaskForProduct(product: Pick<ProductSummary, "id" | "status" | "productId">): ProductWorkflowTask | undefined;
  completeSavedProductWorkflowTasks(): ProductWorkflowTask[];
  reconcileSupersededWorkflowTasks(): ProductWorkflowTask[];
  getWorkflowTask(id: string): ProductWorkflowTask | undefined;
  latestWorkflowTaskForProduct(localProductId: string): ProductWorkflowTask | undefined;
  listWorkflowTasks(): ProductWorkflowTask[];
  abandonWorkflowTask(id: string): ProductWorkflowTask;
  updateWorkflowTask(id: string, patch: Parameters<typeof import("../parts/workflow-tasks.js").updateWorkflowTask>[2]): ProductWorkflowTask;
  recoverOrphanWorkflowTasks(): ProductWorkflowTask[];
  loadPlanningState(localProductId: string): PlanningGenerationState | undefined;
  savePlanningState(state: PlanningGenerationState): void;
  deletePlanningState(localProductId: string): void;
  recoverOrphanPlanningStates(): string[];
  getAgentSnapshot(localProductId: string): AgentSnapshot | undefined;
  saveAgentSnapshot(snapshot: AgentSnapshot): void;

  // memory + cache
  saveUserMemory(input: MemoryInput): MemorySaveResult;
  listUserMemories(ownerUserId: number, filter?: MemoryFilter): UserMemory[];
  getUserMemory(ownerUserId: number, id: string): UserMemory | undefined;
  updateUserMemory(ownerUserId: number, id: string, patch: MemoryPatch): UserMemory;
  disableUserMemory(ownerUserId: number, id: string): UserMemory;
  deleteUserMemory(ownerUserId: number, id: string): void;
  markMemoryUsed(ownerUserId: number, id: string): void;
  addMemoryEvidence(input: Parameters<typeof import("../parts/memory.js").addMemoryEvidence>[1]): UserMemoryEvidence;
  listMemoryEvidence(ownerUserId: number, memoryId: string): UserMemoryEvidence[];
  getMemoryMaintenanceState(ownerUserId: number): MemoryMaintenanceState;
  createOrUpdateMemoryState(ownerUserId: number, patch: Parameters<typeof import("../parts/memory.js").createOrUpdateMemoryState>[2]): void;
  bumpMemoryMaintenanceCursor(ownerUserId: number, cursorTaskId?: string): void;
  clearMemoryMaintenancePending(ownerUserId: number): void;
  markMemorySuccess(ownerUserId: number): void;
  getMemoryByTopic(ownerUserId: number, topic: string): UserMemory[];
  getCachedCtripPoiAvailability(poiId: number): CachedCtripPoiAvailability | undefined;
  saveCachedCtripPoiAvailability(entry: CachedCtripPoiAvailability): void;

  // operation log + helpers
  appendOperationLog(entry: Record<string, unknown> & { id: string; type: string; name: string; status: string; startedAt: string }): void;
  countOperationLog(): number;
  queryOperationLog(query: Parameters<typeof import("../parts/operation-log.js").queryOperationLog>[1]): Array<OperationLogRow>;
  recoverOrphanOperationLog(): number;
  hasColumn(table: string, column: string): boolean;
}

export interface VbkDatabaseStatics {
  readonly OPERATION_LOG_CAP: number;
  fixedInfoSchema(): AccountFixedInfoField[];
}