/**
 * VbkDatabase 产品 + 消息 + research task + automation run 部分：
 *   - listProducts / listProductsPaginated / createProduct /
 *     buildProductSnapshot / getProduct / importProductSnapshot /
 *     deleteProduct / updateProduct /
 *     replaceProductAndSatisfyResearchTasks / updateBasicInfoField /
 *     setProductId / setBasicInfoSaved / setProductLifecycle /
 *     writeAutomationWithProductStatus
 *   - addMessage / updateMessageStatus / recoverUnansweredMessages /
 *     recoverOrphanAutomationRuns
 *   - addResearchTask / markResearchAccepted / markResearchTasksSatisfied /
 *     reopenKindSupersededPoiResearchTasks /
 *     markResearchTasksSatisfiedByProduct / saveAutomation
 *
 * 实现策略：方法集合对象；database.ts 用 Object.assign 合并到 VbkDatabase。
 */

import type {
  AutomationRun,
  ConversationMessage,
  CreateProductInput,
  ProductDetail,
  ProductSummary,
  ResearchTask,
  TaskStatus,
} from "../../../../shared/contracts.js";
import type Database from "better-sqlite3";
import { buildProductSnapshot } from "../parts/product-draft.js";
import {
  replaceProductAndSatisfyResearchTasks,
  type ReplaceProductAndSatisfyResearchTasksOptions,
} from "../parts/replace-product-with-research-tasks.js";
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
} from "../parts/products.js";
import {
  addResearchTask,
  markResearchAccepted,
  markResearchTasksSatisfied,
  markResearchTasksSatisfiedByProduct,
  reopenKindSupersededPoiResearchTasks,
} from "../parts/research-tasks.js";

export const productMethods = {
  listProducts(this: { db: Database.Database }): ProductSummary[] { return listProducts(this.db); },
  listProductsPaginated(this: { db: Database.Database }, page: number, pageSize?: number): ProductListPage { return listProductsPaginated(this.db, page, pageSize); },
  createProduct(this: { db: Database.Database }, input: CreateProductInput): ProductDetail { return createProduct(this.db, input); },
  buildProductSnapshot(this: { db: Database.Database }, input: CreateProductInput): ProductDetail { return buildProductSnapshot(input); },
  getProduct(this: { db: Database.Database }, id: string): ProductDetail | undefined { return getProduct(this.db, id); },
  importProductSnapshot(this: { db: Database.Database }, snapshot: ProductDetail): ProductDetail { return importProductSnapshot(this.db, snapshot); },
  deleteProduct(this: { db: Database.Database }, id: string): boolean { return deleteProduct(this.db, id); },
  updateProduct(this: { db: Database.Database }, id: string, product: Record<string, unknown>, status?: ProductSummary["status"], expectedVersion?: number) { updateProduct(this.db, id, product, status, expectedVersion); },
  replaceProductAndSatisfyResearchTasks(
    this: { db: Database.Database },
    localProductId: string,
    product: Record<string, unknown>,
    options?: ReplaceProductAndSatisfyResearchTasksOptions,
  ): { product: ProductDetail; confirmedTaskIds: string[] } {
    return replaceProductAndSatisfyResearchTasks(this.db, localProductId, product, options);
  },
  updateBasicInfoField(this: { db: Database.Database }, localProductId: string, field: string, value: string): ProductDetail { return updateBasicInfoField(this.db, localProductId, field, value); },
  setProductId(this: { db: Database.Database }, localProductId: string, productId: string) { setProductId(this.db, localProductId, productId); },
  setBasicInfoSaved(this: { db: Database.Database }, localProductId: string, saved = true) { setBasicInfoSaved(this.db, localProductId, saved); },
  setProductLifecycle(this: { db: Database.Database }, localProductId: string, updates: { productId?: string | null; status?: ProductSummary["status"]; basicInfoSaved?: boolean }): void { setProductLifecycle(this.db, localProductId, updates); },
  writeAutomationWithProductStatus(this: { db: Database.Database }, localProductId: string, run: AutomationRun, status: ProductSummary["status"]): void { writeAutomationWithProductStatus(this.db, localProductId, run, status); },
  addMessage(this: { db: Database.Database }, localProductId: string, role: ConversationMessage["role"], content: string, taskStatus?: ConversationMessage["taskStatus"]) { return addMessage(this.db, localProductId, role, content, taskStatus); },
  updateMessageStatus(this: { db: Database.Database }, localProductId: string, messageId: string, taskStatus: TaskStatus) { updateMessageStatus(this.db, localProductId, messageId, taskStatus); },
  recoverUnansweredMessages(this: { db: Database.Database }) { recoverUnansweredMessages(this.db); },
  recoverOrphanAutomationRuns(this: { db: Database.Database }) { return recoverOrphanAutomationRuns(this.db); },
  addResearchTask(this: { db: Database.Database }, localProductId: string, task: Pick<ResearchTask, "label" | "type" | "detail">) { return addResearchTask(this.db, localProductId, task); },
  markResearchAccepted(this: { db: Database.Database }, localProductId: string, taskId: string, note?: string, source: "vbk" | "web" | "user" = "user") { markResearchAccepted(this.db, localProductId, taskId, note, source); },
  markResearchTasksSatisfied(this: { db: Database.Database }, localProductId: string, taskIds: readonly string[], note?: string) { return markResearchTasksSatisfied(this.db, localProductId, taskIds, note); },
  reopenKindSupersededPoiResearchTasks(this: { db: Database.Database }, localProductId: string, product: Record<string, unknown>) { return reopenKindSupersededPoiResearchTasks(this.db, localProductId, product); },
  markResearchTasksSatisfiedByProduct(this: { db: Database.Database }, localProductId: string, product: Record<string, unknown>) { return markResearchTasksSatisfiedByProduct(this.db, localProductId, product); },
  saveAutomation(this: { db: Database.Database }, localProductId: string, run: AutomationRun) { saveAutomation(this.db, localProductId, run); },
} as const;