/**
 * 产品 CRUD：
 *   - createProduct：本地用 buildProductSnapshot 生成初始 product，再 importProductSnapshot 落库。
 *   - importProductSnapshot：把 Tibet 远端 snapshot 写入本地 SQLite 行；
 *     journal（automation_runs）按 run id 合并而非删除；existing 情况下删 messages
 *     / research_tasks / planning_generation 后再 insert。
 *   - getProduct：读产品详情 + 关联 messages / research_tasks / automation run。
 *   - deleteProduct：事务化删除 products / 关联表；automating / running 中拒绝删除。
 *
 * Tibet is the authority for product and planning state. The SQLite row is a
 * compatibility cache for existing mutation/automation code, so a remote read
 * replaces those business fields. The local automation journal is merged by
 * run id below rather than being deleted with the business snapshot.
 */

import type Database from "better-sqlite3";
import type { ConversationMessage, CreateProductInput, ProductDetail, ResearchTask } from "../../../../../shared/contracts.js";
import { coalescePoiResearchTasks } from "../product-research-tasks.js";
import { parseAndNormalizeProductJson } from "../../product-json-normalize.js";
import { automationJournalImport, type StoredAutomationRun } from "../automation-journal-merge.js";
import { buildProductSnapshot } from "../product-draft.js";
import { ensureProductExecutionTime, readProductExecutionTime } from "../../../../operations/product-execution-clock.js";
import { now } from "../types.js";
import { readLocalProductState } from "../local-product-state.js";

export function createProduct(db: Database.Database, input: CreateProductInput): ProductDetail {
  return importProductSnapshot(db, buildProductSnapshot(input));
}

export function importProductSnapshot(db: Database.Database, snapshot: ProductDetail): ProductDetail {
  const existing = getProduct(db, snapshot.id);
  const existingCreatedAt = (db.prepare("SELECT created_at FROM products WHERE id=?").get(snapshot.id) as { created_at: string } | undefined)?.created_at;
  const product = parseAndNormalizeProductJson(JSON.stringify(snapshot.product));
  const restoredAt = snapshot.updatedAt || now();
  const restore = db.transaction(() => {
    // Read this journal before replacing the product row. It intentionally is
    // not part of the remote product snapshot's destructive business import.
    const localRuns = db.prepare(
      "SELECT id,local_product_id,payload_json,created_at,updated_at FROM automation_runs WHERE local_product_id=?",
    ).all(snapshot.id).map((row) => {
      const value = row as Record<string, string>;
      return {
        id: value.id,
        localProductId: value.local_product_id,
        payloadJson: value.payload_json,
        createdAt: value.created_at,
        updatedAt: value.updated_at,
      } satisfies StoredAutomationRun;
    });
    const foreignRunIdExists = Boolean(snapshot.automation && db.prepare(
      "SELECT 1 FROM automation_runs WHERE id=? AND local_product_id<>? LIMIT 1",
    ).get(snapshot.automation.id, snapshot.id));
    const journal = automationJournalImport(
      localRuns,
      snapshot.automation as (typeof snapshot.automation & { updatedAt?: unknown }) | undefined,
      restoredAt,
      foreignRunIdExists,
    );
    if (existing) {
      db.prepare("DELETE FROM research_tasks WHERE local_product_id=?").run(snapshot.id);
      db.prepare("DELETE FROM messages WHERE local_product_id=?").run(snapshot.id);
      if (!readLocalProductState(db, snapshot.id)) db.prepare("DELETE FROM planning_generation WHERE local_product_id=?").run(snapshot.id);
      db.prepare("DELETE FROM products WHERE id=?").run(snapshot.id);
    }
    db.prepare(
      "INSERT INTO products(id,name,status,product_id,product_json,created_at,updated_at,basic_info_saved,product_json_version) VALUES(?,?,?,?,?,?,?,?,?)",
    ).run(
      snapshot.id,
      snapshot.name,
      snapshot.status,
      snapshot.productId ?? null,
      JSON.stringify(product),
      existingCreatedAt ?? restoredAt,
      restoredAt,
      snapshot.basicInfoSaved ? 1 : 0,
      existing ? (existing.productJsonVersion ?? 0) + (JSON.stringify(existing.product) === JSON.stringify(product) ? 0 : 1) : 0,
    );
    const insertMessage = db.prepare(
      "INSERT OR IGNORE INTO messages(id,local_product_id,role,content,task_status,created_at) VALUES(?,?,?,?,?,?)",
    );
    for (const message of snapshot.messages) {
      insertMessage.run(message.id, snapshot.id, message.role, message.content, message.taskStatus ?? null, message.createdAt);
    }
    const insertTask = db.prepare(
      "INSERT OR IGNORE INTO research_tasks(id,local_product_id,label,type,status,state,detail,evidence_json) VALUES(?,?,?,?,?,?,?,?)",
    );
    for (const task of snapshot.researchTasks) {
      insertTask.run(
        task.id,
        snapshot.id,
        task.label,
        task.type,
        task.status,
        task.state,
        task.detail ?? null,
        JSON.stringify(task.evidence ?? []),
      );
    }
    if (journal.action === "insert") {
      db.prepare(
        "INSERT INTO automation_runs(id,local_product_id,payload_json,created_at,updated_at) VALUES(?,?,?,?,?)",
      ).run(journal.run.id, snapshot.id, JSON.stringify(journal.run), restoredAt, journal.updatedAt);
    } else if (journal.action === "replace") {
      db.prepare(
        "UPDATE automation_runs SET payload_json=?,updated_at=? WHERE id=? AND local_product_id=?",
      ).run(JSON.stringify(journal.run), journal.updatedAt, journal.run.id, snapshot.id);
    }
  });
  restore();
  ensureProductExecutionTime(db, snapshot.id);
  return {
    ...getProduct(db, snapshot.id)!,
    vbkAccount: snapshot.vbkAccount,
    revision: snapshot.revision,
    planning: snapshot.planning,
    ...(snapshot.aiUsage ? { aiUsage: snapshot.aiUsage } : {}),
  };
}

/**
 * 读产品详情 + 关联 messages / research_tasks / automation run。
 */
export function getProduct(db: Database.Database, id: string): ProductDetail | undefined {
  const product = db.prepare("SELECT * FROM products WHERE id=?").get(id) as Record<string, string> | undefined;
  if (!product) return undefined;
  const messages = db.prepare("SELECT * FROM messages WHERE local_product_id=? ORDER BY created_at").all(id) as Array<Record<string, string>>;
  const tasks = db.prepare("SELECT * FROM research_tasks WHERE local_product_id=?").all(id) as Array<Record<string, string>>;
  const automationRow = db.prepare("SELECT payload_json FROM automation_runs WHERE local_product_id=? ORDER BY updated_at DESC LIMIT 1").get(id) as { payload_json: string } | undefined;
  return {
    id: product.id,
    ...localProductMetadata(db, id),
    name: product.name,
    status: product.status as ProductDetail["status"],
    productId: product.product_id || undefined,
    updatedAt: product.updated_at,
    executionTime: readProductExecutionTime(db, id),
    productJsonVersion: Number((product as Record<string, unknown>).product_json_version ?? 0) || 0,
    product: parseAndNormalizeProductJson(product.product_json),
    messages: messages.map((m) => ({ id: m.id, role: m.role as ConversationMessage["role"], content: m.content, createdAt: m.created_at, taskStatus: m.task_status as ConversationMessage["taskStatus"] })),
    researchTasks: coalescePoiResearchTasks(tasks.map((t) => ({ id: t.id, label: t.label, type: t.type as ResearchTask["type"], status: t.status as ResearchTask["status"], state: t.state as ResearchTask["state"], detail: t.detail || undefined, evidence: JSON.parse(t.evidence_json) }))),
    automation: automationRow ? JSON.parse(automationRow.payload_json) : undefined,
    basicInfoSaved: Number(product.basic_info_saved) === 1,
  };
}

function localProductMetadata(db: Database.Database, id: string): Partial<ProductDetail> {
  const state = readLocalProductState(db, id);
  if (!state) return {};
  const { ownerUserId: _owner, ...metadata } = state;
  return metadata;
}

/**
 * 删除产品及其所有关联数据。事务化删除：automation_runs / research_tasks /
 * messages / planning_generation / products。禁止在 automating 中或 AI 跑着时删除。
 */
export function deleteProduct(db: Database.Database, id: string): boolean {
  const remove = db.transaction((localProductId: string) => {
    const product = getProduct(db, localProductId);
    if (!product) return false;
    if (product.status === "automating" || product.automation?.status === "running") {
      throw new Error("产品正在自动录入，完成或停止后才能删除。");
    }
    const activeMessage = db.prepare("SELECT 1 FROM messages WHERE local_product_id=? AND task_status='running' LIMIT 1").get(localProductId);
    if (activeMessage) throw new Error("AI 正在处理这个产品，请等待本轮完成后再删除。");
    const activeWorkflowTask = db.prepare(`
      SELECT 1 FROM workflow_tasks
      WHERE local_product_id=? AND status IN ('queued','running') LIMIT 1
    `).get(localProductId);
    if (activeWorkflowTask) throw new Error("后台任务正在处理这个产品，请等待任务完成后再删除。");
    db.prepare("DELETE FROM workflow_tasks WHERE local_product_id=?").run(localProductId);
    db.prepare("DELETE FROM automation_runs WHERE local_product_id=?").run(localProductId);
    db.prepare("DELETE FROM research_tasks WHERE local_product_id=?").run(localProductId);
    db.prepare("DELETE FROM messages WHERE local_product_id=?").run(localProductId);
    db.prepare("DELETE FROM planning_generation WHERE local_product_id=?").run(localProductId);
    db.prepare("DELETE FROM local_product_state WHERE local_product_id=?").run(localProductId);
    db.prepare("DELETE FROM products WHERE id=?").run(localProductId);
    return true;
  });
  return remove(id);
}