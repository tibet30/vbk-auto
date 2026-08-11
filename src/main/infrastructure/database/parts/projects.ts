/**
 * 项目 CRUD + 会话消息 + research + automation 写入：
 *   - listProjects / createProject / getProject / deleteProject
 *   - updateProduct / updateBasicInfoField / setProductId / setBasicInfoSaved
 *   - setProjectLifecycle / writeAutomationWithProjectStatus（事务化多表写入）
 *   - addMessage / updateMessageStatus / recoverUnansweredMessages
 *   - saveAutomation / recoverOrphanAutomationRuns
 *
 * 全部接受 Database.Database 句柄，便于在拆分模块上复用同一个连接。
 */

import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import type {
  AutomationRun,
  ConversationMessage,
  CreateProjectInput,
  ProjectDetail,
  ProjectSummary,
  ResearchTask,
  TaskStatus,
} from "../../../../shared/contracts.js";
import { DEFAULT_HOTEL_TIER } from "../../../../shared/hotel-tiers.js";
import {
  canonicalPoiResearchTaskLabel,
  poiResearchTaskName,
} from "../../../../shared/poi-research-tasks.js";
import { parseAndNormalizeProductJson } from "../product-json-normalize.js";
import { now, newId, newSupplierProductCode } from "./types.js";

function preferLogicalPoiTask(current: ResearchTask, candidate: ResearchTask): ResearchTask {
  const rank: Record<ResearchTask["state"], number> = {
    proposed: 0,
    researching: 1,
    blocked: 2,
    confirmed: 3,
    resolved: 4,
    needs_confirmation: 2,
  };
  return rank[candidate.state] > rank[current.state] ? candidate : current;
}

/**
 * Legacy POI rows remain untouched for auditability. Detail reads expose their
 * semantic union as one canonical task, so operators do not see duplicate work.
 */
function coalescePoiResearchTasks(tasks: ResearchTask[]): ResearchTask[] {
  const result: ResearchTask[] = [];
  const groups = new Map<string, ResearchTask[]>();
  for (const task of tasks) {
    const name = poiResearchTaskName(task.label, task.type);
    if (!name) {
      result.push(task);
      continue;
    }
    const key = `${task.type}::${name}`;
    groups.set(key, [...(groups.get(key) ?? []), task]);
  }
  for (const group of groups.values()) {
    const primary = group.reduce(preferLogicalPoiTask);
    const detail = [...new Set(group.map((task) => task.detail).filter((value): value is string => !!value))].join("；") || undefined;
    const evidence = group.flatMap((task) => task.evidence ?? []);
    result.push({
      ...primary,
      label: canonicalPoiResearchTaskLabel(primary.label, primary.type),
      detail,
      evidence,
    });
  }
  return result;
}

/**
 * 项目列表（按 updated_at 倒序）。
 */
export function listProjects(db: Database.Database): ProjectSummary[] {
  return (db.prepare("SELECT id,name,status,product_id,updated_at FROM projects ORDER BY updated_at DESC").all() as Array<Record<string, string>>)
    .map((row) => ({ id: row.id, name: row.name, status: row.status as ProjectSummary["status"], productId: row.product_id || undefined, updatedAt: row.updated_at }));
}

/** 分页项目列表结果。 */
export interface ProjectListPage {
  items: ProjectSummary[];
  total: number;
}

/**
 * 分页项目列表（按 updated_at 倒序）。
 * page 从 1 起；pageSize 默认 10。
 */
export function listProjectsPaginated(db: Database.Database, page: number, pageSize = 10): ProjectListPage {
  const total = (db.prepare("SELECT COUNT(*) AS n FROM projects").get() as { n: number }).n;
  const offset = Math.max(0, (page - 1) * pageSize);
  const items = (db.prepare(
    "SELECT id,name,status,product_id,updated_at FROM projects ORDER BY updated_at DESC LIMIT ? OFFSET ?",
  ).all(pageSize, offset) as Array<Record<string, string>>)
    .map((row) => ({ id: row.id, name: row.name, status: row.status as ProjectSummary["status"], productId: row.product_id || undefined, updatedAt: row.updated_at }));
  return { items, total };
}

/**
 * 创建项目并自动追加一条开场白 assistant 消息。
 */
export function createProject(db: Database.Database, input: CreateProjectInput): ProjectDetail {
  const id = randomUUID();
  const createdAt = now();
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
      supplierProductName: name,
      supplierProductCode: newSupplierProductCode(),
      days,
      nights,
      meetingCity: destination,
      destinationCity: destination,
      subtitle: "",
      province: "",
      operationNotes: "",
    },
    operations: {
      hotelSource: "nonPlatform",
      hotelTier: DEFAULT_HOTEL_TIER,
      mealsIncluded: false,
      pickupCity: "",
      vehicleResource: {},
    },
    itinerary: [],
  };
  db.prepare("INSERT INTO projects(id,name,status,product_id,product_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?)").run(id, name, "planning", null, JSON.stringify(product), createdAt, createdAt);
  addMessage(db, id, "assistant", `已创建「${name}」。已带入项目上下文：目的地「${destination}」、产品形态「${formLabel}」、行程「${days}天${nights}晚」。`);
  return getProject(db, id)!;
}

/**
 * 读项目详情 + 关联 messages / research_tasks / automation run。
 */
export function getProject(db: Database.Database, id: string): ProjectDetail | undefined {
  const project = db.prepare("SELECT * FROM projects WHERE id=?").get(id) as Record<string, string> | undefined;
  if (!project) return undefined;
  const messages = db.prepare("SELECT * FROM messages WHERE project_id=? ORDER BY created_at").all(id) as Array<Record<string, string>>;
  const tasks = db.prepare("SELECT * FROM research_tasks WHERE project_id=?").all(id) as Array<Record<string, string>>;
  const automationRow = db.prepare("SELECT payload_json FROM automation_runs WHERE project_id=? ORDER BY updated_at DESC LIMIT 1").get(id) as { payload_json: string } | undefined;
  return {
    id: project.id,
    name: project.name,
    status: project.status as ProjectDetail["status"],
    productId: project.product_id || undefined,
    updatedAt: project.updated_at,
    product: parseAndNormalizeProductJson(project.product_json),
    messages: messages.map((m) => ({ id: m.id, role: m.role as ConversationMessage["role"], content: m.content, createdAt: m.created_at, taskStatus: m.task_status as ConversationMessage["taskStatus"] })),
    researchTasks: coalescePoiResearchTasks(tasks.map((t) => ({ id: t.id, label: t.label, type: t.type as ResearchTask["type"], status: t.status as ResearchTask["status"], state: t.state as ResearchTask["state"], detail: t.detail || undefined, evidence: JSON.parse(t.evidence_json) }))),
    automation: automationRow ? JSON.parse(automationRow.payload_json) : undefined,
    basicInfoSaved: Number(project.basic_info_saved) === 1,
  };
}

/**
 * 删除项目及其所有关联数据。事务化删除：automation_runs / research_tasks /
 * messages / planning_generation / projects。禁止在 automating 中或 AI 跑着时删除。
 */
export function deleteProject(db: Database.Database, id: string): boolean {
  const remove = db.transaction((projectId: string) => {
    const project = getProject(db, projectId);
    if (!project) return false;
    if (project.status === "automating" || project.automation?.status === "running") {
      throw new Error("项目正在自动录入，完成或停止后才能删除。");
    }
    const activeMessage = db.prepare("SELECT 1 FROM messages WHERE project_id=? AND task_status='running' LIMIT 1").get(projectId);
    if (activeMessage) throw new Error("AI 正在处理这个项目，请等待本轮完成后再删除。");
    db.prepare("DELETE FROM automation_runs WHERE project_id=?").run(projectId);
    db.prepare("DELETE FROM research_tasks WHERE project_id=?").run(projectId);
    db.prepare("DELETE FROM messages WHERE project_id=?").run(projectId);
    db.prepare("DELETE FROM planning_generation WHERE project_id=?").run(projectId);
    db.prepare("DELETE FROM projects WHERE id=?").run(projectId);
    return true;
  });
  return remove(id);
}

/** 写入一条会话消息；并 touch 项目。 */
export function addMessage(
  db: Database.Database,
  projectId: string,
  role: ConversationMessage["role"],
  content: string,
  taskStatus?: ConversationMessage["taskStatus"],
) {
  const id = randomUUID();
  db.prepare("INSERT INTO messages VALUES(?,?,?,?,?,?)").run(id, projectId, role, content, taskStatus || null, now());
  touchProject(db, projectId);
  return id;
}

/** 更新一条消息的 task_status。 */
export function updateMessageStatus(db: Database.Database, projectId: string, messageId: string, taskStatus: TaskStatus) {
  db.prepare("UPDATE messages SET task_status=? WHERE id=? AND project_id=?").run(taskStatus, messageId, projectId);
  touchProject(db, projectId);
}

/**
 * 启动时清理"未答完"消息：role=user 且 task_status=running/空、且之后
 * 没有 assistant 回复（在下一条 user 之前）。把它们标记为 failed 并补一
 * 条"上一轮未获得 AI 回复"的说明。
 */
export function recoverUnansweredMessages(db: Database.Database): void {
  const unanswered = db.prepare(`
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
    updateMessageStatus(db, message.project_id, message.id, "failed");
    addMessage(db, message.project_id, "assistant", "上一轮在应用关闭前没有完成，未获得 AI 回复。请重新发送这条消息。", "failed");
  }
}

/**
 * 重启时清理 automation.status=running 的孤儿 run：标记为 failed，
 * 把 recovery.phases 里仍处于 running / advising / retrying 的记录强制
 * 改成 needs_user，并补一条 warning log。返回受影响的项目 ID 列表。
 */
export function recoverOrphanAutomationRuns(db: Database.Database): string[] {
  const orphans = db.prepare(`
    SELECT project_id, payload_json FROM automation_runs
    WHERE payload_json LIKE '%"status":"running"%'
  `).all() as Array<{ project_id: string; payload_json: string }>;
  const touchedProjects: string[] = [];
  const updateRun = db.prepare("UPDATE automation_runs SET payload_json=?, updated_at=? WHERE project_id=? AND payload_json LIKE '%\"status\":\"running\"%'");
  const updateProject = db.prepare("UPDATE projects SET status=?, updated_at=? WHERE id=?");
  const tx = db.transaction(() => {
    for (const row of orphans) {
      try {
        const run = JSON.parse(row.payload_json) as AutomationRun;
        if (run.status !== "running") continue;
        run.status = "failed";
        if (run.recovery?.phases) {
          for (const rec of Object.values(run.recovery.phases)) {
            if (rec.state === "running" || rec.state === "advising" || rec.state === "retrying") {
              rec.state = "needs_user";
              rec.finalError = rec.finalError || "应用重启导致自动录入被中断";
              if (!rec.userInstruction) rec.userInstruction = "请在 VBK 核查基础信息后重新保存草稿。";
            }
          }
          run.logs.push({ at: new Date().toISOString(), message: "应用重启，自动录入已停止，请重新保存草稿", level: "warning" });
        }
        updateRun.run(JSON.stringify(run), now(), row.project_id);
        const project = db.prepare("SELECT status FROM projects WHERE id=?").get(row.project_id) as { status: string } | undefined;
        if (project && project.status !== "draft_saved" && project.status !== "blocked") {
          updateProject.run("blocked", now(), row.project_id);
        }
        touchedProjects.push(row.project_id);
      } catch { /* leave unreadable legacy payload untouched */ }
    }
  });
  tx();
  return touchedProjects;
}

/**
 * 写入项目 product_json，可选更新 status。直接覆盖整个 product 字段。
 */
export function updateProduct(db: Database.Database, id: string, product: Record<string, unknown>, status?: ProjectSummary["status"]) {
  db.prepare("UPDATE projects SET product_json=?, status=COALESCE(?,status), updated_at=? WHERE id=?")
    .run(JSON.stringify(product), status || null, now(), id);
}

/**
 * 运营可直接维护 AI 不允许写入的基础信息字段（例如供应商产品编号）。
 * 返回更新后的完整项目。
 */
export function updateBasicInfoField(db: Database.Database, projectId: string, field: string, value: string): ProjectDetail {
  const project = getProject(db, projectId);
  if (!project) throw new Error("项目不存在");
  const trimmed = value.trim();
  if (!trimmed) throw new Error("内容不能为空。");
  const product = { ...project.product } as Record<string, unknown>;
  const basicInfo = product.basicInfo && typeof product.basicInfo === "object" && !Array.isArray(product.basicInfo)
    ? { ...(product.basicInfo as Record<string, unknown>) }
    : {};
  basicInfo[field] = trimmed;
  product.basicInfo = basicInfo;
  updateProduct(db, projectId, product);
  return getProject(db, projectId)!;
}

/**
 * 保存/替换某项目的 automation run；同 run.id 多次保存会覆盖。
 */
export function saveAutomation(db: Database.Database, projectId: string, run: AutomationRun) {
  const tx = db.transaction(() => {
    db.prepare("INSERT INTO automation_runs(id,project_id,payload_json,created_at,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET payload_json=excluded.payload_json,updated_at=excluded.updated_at")
      .run(run.id, projectId, JSON.stringify(run), now(), now());
    touchProject(db, projectId);
  });
  tx();
}

/** 更新 product_id 字段（产品壳生成后回填）。 */
export function setProductId(db: Database.Database, projectId: string, productId: string) {
  const tx = db.transaction(() => db.prepare("UPDATE projects SET product_id=?,updated_at=? WHERE id=?").run(productId, now(), projectId));
  tx();
}

/** 标记基本信息是否在 VBK 保存成功。 */
export function setBasicInfoSaved(db: Database.Database, projectId: string, saved = true) {
  const tx = db.transaction(() => db.prepare("UPDATE projects SET basic_info_saved=?,updated_at=? WHERE id=?").run(saved ? 1 : 0, now(), projectId));
  tx();
}

/**
 * 事务化更新：product_id + status + basicInfoSaved 任一字段 + touch 都是
 * 一个原子写入，便于在 status/automation 切换场景中保持一致。
 */
export function setProjectLifecycle(
  db: Database.Database,
  projectId: string,
  updates: { productId?: string; status?: ProjectSummary["status"]; basicInfoSaved?: boolean },
): void {
  const tx = db.transaction(() => {
    if (updates.productId !== undefined) db.prepare("UPDATE projects SET product_id=?, updated_at=? WHERE id=?").run(updates.productId, now(), projectId);
    if (updates.status !== undefined) db.prepare("UPDATE projects SET status=?, updated_at=? WHERE id=?").run(updates.status, now(), projectId);
    if (updates.basicInfoSaved !== undefined) db.prepare("UPDATE projects SET basic_info_saved=?, updated_at=? WHERE id=?").run(updates.basicInfoSaved ? 1 : 0, now(), projectId);
    touchProject(db, projectId);
  });
  tx();
}

/**
 * 一次性事务写：项目状态 + 自动化运行 要么全成、要么全失败。
 * 业务上 project.status="automating" 与 automation run payload 是一致单元。
 */
export function writeAutomationWithProjectStatus(db: Database.Database, projectId: string, run: AutomationRun, status: ProjectSummary["status"]): void {
  const tx = db.transaction(() => {
    db.prepare("UPDATE projects SET status=?, updated_at=? WHERE id=?").run(status, now(), projectId);
    db.prepare("INSERT INTO automation_runs(id,project_id,payload_json,created_at,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET payload_json=excluded.payload_json,updated_at=excluded.updated_at")
      .run(run.id, projectId, JSON.stringify(run), now(), now());
  });
  tx();
}

/** touch 项目的 updated_at。 */
export function touchProject(db: Database.Database, id: string) {
  db.prepare("UPDATE projects SET updated_at=? WHERE id=?").run(now(), id);
}
