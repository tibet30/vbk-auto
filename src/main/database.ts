import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { AutomationRun, ConversationMessage, CreateProjectInput, ProjectDetail, ProjectSummary, ResearchTask, TaskStatus } from "../shared/contracts.js";
import { normaliseProductDraft } from "./product-normalize.js";

const now = () => new Date().toISOString();

// 供应商产品编号是自动录入的必填项，且 AI 被禁止写入（属于运营数据）。
// 建项目时先生成一个唯一占位编号，运营可在产品面板改成 VBK 中的真实编号。
function newSupplierProductCode() {
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  return `VBK-${stamp}-${randomUUID().slice(0, 6).toUpperCase()}`;
}

export class VbkDatabase {
  private db: Database.Database;

  constructor(dataPath: string) {
    fs.mkdirSync(dataPath, { recursive: true });
    this.db = new Database(path.join(dataPath, "vbk-desktop.sqlite"));
    this.db.pragma("journal_mode = WAL");
    this.migrate();
    this.normaliseStoredProducts();
  }

  private migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, status TEXT NOT NULL, product_id TEXT,
        product_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL,
        task_status TEXT, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS research_tasks (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL, label TEXT NOT NULL, type TEXT NOT NULL,
        status TEXT NOT NULL, state TEXT NOT NULL, detail TEXT, evidence_json TEXT NOT NULL DEFAULT '[]'
      );
      CREATE TABLE IF NOT EXISTS automation_runs (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL, payload_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
  }

  private normaliseStoredProducts() {
    const rows = this.db.prepare("SELECT id, product_json FROM projects").all() as Array<{ id: string; product_json: string }>;
    const update = this.db.prepare("UPDATE projects SET product_json=? WHERE id=?");
    const apply = this.db.transaction(() => {
      for (const row of rows) {
        try {
          const normalised = JSON.stringify(normaliseProductDraft(JSON.parse(row.product_json)));
          if (normalised !== row.product_json) update.run(normalised, row.id);
        } catch { /* Leave unreadable legacy data untouched for manual recovery. */ }
      }
    });
    apply();
  }

  getSetting(key: string) { return this.db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined; }
  setSetting(key: string, value: string) { this.db.prepare("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, value); }

  listProjects(): ProjectSummary[] {
    return (this.db.prepare("SELECT id,name,status,product_id,updated_at FROM projects ORDER BY updated_at DESC").all() as Array<Record<string, string>>)
      .map((row) => ({ id: row.id, name: row.name, status: row.status as ProjectSummary["status"], productId: row.product_id || undefined, updatedAt: row.updated_at }));
  }

  createProject(input: CreateProjectInput): ProjectDetail {
    const id = randomUUID(); const createdAt = now();
    const destination = typeof input?.destination === "string" ? input.destination.trim() : "";
    if (!destination) throw new Error("请填写有效的目的地。");

    const days = Number(input.days);
    if (!Number.isInteger(days) || days < 1 || days > 60) throw new Error("天数需为 1 至 60 天的整数。");

    const productForm = input.productForm;
    if (productForm !== "privateTour" && productForm !== "groupTour") throw new Error("请选择有效的产品形态。");

    const formLabel = productForm === "privateTour" ? "私家团" : "跟团游";
    const nights = Math.max(0, days - 1);
    const name = `${destination}${days}天${nights}晚${formLabel}`;
    const product = {
      sales: { productType: days <= 5 ? "domesticShort" : "domesticLong", productForm, splitGroup: false },
      basicInfo: {
        supplierProductName: name, supplierProductCode: newSupplierProductCode(),
        days, nights, meetingCity: destination, destinationCity: destination,
      },
      itinerary: [],
    };
    this.db.prepare("INSERT INTO projects VALUES(?,?,?,?,?,?,?)").run(id, name, "planning", null, JSON.stringify(product), createdAt, createdAt);
    this.addMessage(id, "assistant", `已创建「${name}」。已带入项目上下文：目的地「${destination}」、产品形态「${formLabel}」、行程「${days}天${nights}晚」。请告诉我你希望生成或调整什么方案。`);
    return this.getProject(id)!;
  }

  getProject(id: string): ProjectDetail | undefined {
    const project = this.db.prepare("SELECT * FROM projects WHERE id=?").get(id) as Record<string, string> | undefined;
    if (!project) return undefined;
    const messages = this.db.prepare("SELECT * FROM messages WHERE project_id=? ORDER BY created_at").all(id) as Array<Record<string, string>>;
    const tasks = this.db.prepare("SELECT * FROM research_tasks WHERE project_id=?").all(id) as Array<Record<string, string>>;
    const automationRow = this.db.prepare("SELECT payload_json FROM automation_runs WHERE project_id=? ORDER BY updated_at DESC LIMIT 1").get(id) as { payload_json: string } | undefined;
    return {
      id: project.id, name: project.name, status: project.status as ProjectDetail["status"], productId: project.product_id || undefined,
      updatedAt: project.updated_at, product: JSON.parse(project.product_json),
      messages: messages.map((m) => ({ id: m.id, role: m.role as ConversationMessage["role"], content: m.content, createdAt: m.created_at, taskStatus: m.task_status as ConversationMessage["taskStatus"] })),
      researchTasks: tasks.map((t) => ({ id: t.id, label: t.label, type: t.type as ResearchTask["type"], status: t.status as ResearchTask["status"], state: t.state as ResearchTask["state"], detail: t.detail || undefined, evidence: JSON.parse(t.evidence_json) })),
      automation: automationRow ? JSON.parse(automationRow.payload_json) : undefined,
    };
  }

  addMessage(projectId: string, role: ConversationMessage["role"], content: string, taskStatus?: ConversationMessage["taskStatus"]) {
    const id = randomUUID();
    this.db.prepare("INSERT INTO messages VALUES(?,?,?,?,?,?)").run(id, projectId, role, content, taskStatus || null, now()); this.touch(projectId);
    return id;
  }
  updateMessageStatus(projectId: string, messageId: string, taskStatus: TaskStatus) {
    this.db.prepare("UPDATE messages SET task_status=? WHERE id=? AND project_id=?").run(taskStatus, messageId, projectId); this.touch(projectId);
  }
  recoverUnansweredMessages() {
    const unanswered = this.db.prepare(`
      SELECT message.id, message.project_id FROM messages AS message
      WHERE message.role='user' AND (message.task_status IS NULL OR message.task_status='running')
        AND NOT EXISTS (
          SELECT 1 FROM messages AS reply
          WHERE reply.project_id=message.project_id AND reply.role='assistant' AND reply.created_at > message.created_at
            AND reply.created_at < COALESCE((
              SELECT MIN(next_message.created_at) FROM messages AS next_message
              WHERE next_message.project_id=message.project_id AND next_message.role='user' AND next_message.created_at > message.created_at
            ), '9999-12-31T23:59:59.999Z')
        )
    `).all() as Array<{ id: string; project_id: string }>;
    for (const message of unanswered) {
      this.updateMessageStatus(message.project_id, message.id, "failed");
      this.addMessage(message.project_id, "assistant", "上一轮在应用关闭前没有完成，未获得 AI 回复。请重新发送这条消息。", "failed");
    }
  }
  updateProduct(id: string, product: Record<string, unknown>, status?: ProjectSummary["status"]) {
    this.db.prepare("UPDATE projects SET product_json=?, status=COALESCE(?,status), updated_at=? WHERE id=?").run(JSON.stringify(product), status || null, now(), id);
  }
  // 运营可直接维护 AI 不允许写入的基础信息字段（例如供应商产品编号）。
  updateBasicInfoField(projectId: string, field: string, value: string): ProjectDetail {
    const project = this.getProject(projectId);
    if (!project) throw new Error("项目不存在");
    const trimmed = value.trim();
    if (!trimmed) throw new Error("内容不能为空。");
    const product = { ...project.product } as Record<string, unknown>;
    const basicInfo = product.basicInfo && typeof product.basicInfo === "object" && !Array.isArray(product.basicInfo)
      ? { ...(product.basicInfo as Record<string, unknown>) }
      : {};
    basicInfo[field] = trimmed;
    product.basicInfo = basicInfo;
    this.updateProduct(projectId, product);
    return this.getProject(projectId)!;
  }
  addResearchTask(projectId: string, task: Pick<ResearchTask, "label" | "type" | "detail">) {
    const existing = this.db.prepare(`
      SELECT id FROM research_tasks
      WHERE project_id=? AND label=? AND type=? AND state NOT IN ('confirmed','resolved')
      LIMIT 1
    `).get(projectId, task.label, task.type) as { id: string } | undefined;
    if (existing) {
      if (task.detail) this.db.prepare("UPDATE research_tasks SET detail=? WHERE id=?").run(task.detail, existing.id);
      this.touch(projectId);
      return existing.id;
    }
    const id = randomUUID();
    this.db.prepare("INSERT INTO research_tasks VALUES(?,?,?,?,?,?,?,?)").run(id, projectId, task.label, task.type, "queued", "researching", task.detail || null, "[]"); this.touch(projectId);
    return id;
  }
  markResearchAccepted(projectId: string, taskId: string, note?: string, source: "vbk" | "web" | "user" = "user") {
    const evidence = [{ id: randomUUID(), title: note?.trim() || "运营人员已完成平台核查", source, retrievedAt: now(), accepted: true }];
    this.db.prepare("UPDATE research_tasks SET state='confirmed', status='succeeded', evidence_json=? WHERE id=? AND project_id=?").run(JSON.stringify(evidence), taskId, projectId); this.touch(projectId);
  }
  saveAutomation(projectId: string, run: AutomationRun) {
    this.db.prepare("INSERT INTO automation_runs(id,project_id,payload_json,created_at,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET payload_json=excluded.payload_json,updated_at=excluded.updated_at").run(run.id, projectId, JSON.stringify(run), now(), now()); this.touch(projectId);
  }
  setProductId(projectId: string, productId: string) { this.db.prepare("UPDATE projects SET product_id=?,updated_at=? WHERE id=?").run(productId, now(), projectId); }
  private touch(id: string) { this.db.prepare("UPDATE projects SET updated_at=? WHERE id=?").run(now(), id); }
}
