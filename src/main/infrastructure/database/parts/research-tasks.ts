import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import type { ResearchTask } from "../../../../shared/contracts.js";
import {
  canonicalPoiResearchTaskLabel,
  isSamePoiResearchTask,
} from "../../../../shared/poi-research-tasks.js";
import { now } from "./types.js";
import { touchProject } from "./projects.js";

export function addResearchTask(db: Database.Database, projectId: string, task: Pick<ResearchTask, "label" | "type" | "detail">) {
  const canonicalTask = {
    ...task,
    label: canonicalPoiResearchTaskLabel(task.label, task.type),
  };
  const existing = db.prepare(`
    SELECT id, label, type FROM research_tasks
    WHERE project_id=? AND type=?
  `).all(projectId, canonicalTask.type) as Array<{ id: string; label: string; type: ResearchTask["type"] }>;
  const duplicate = existing.find((row) => row.label === canonicalTask.label)
    ?? existing.find((row) => isSamePoiResearchTask(row, canonicalTask));
  if (duplicate) {
    if (canonicalTask.detail && duplicate.label === canonicalTask.label) {
      db.prepare("UPDATE research_tasks SET detail=? WHERE id=?").run(canonicalTask.detail, duplicate.id);
    }
    touchProject(db, projectId);
    return duplicate.id;
  }
  const id = randomUUID();
  db.prepare("INSERT INTO research_tasks VALUES(?,?,?,?,?,?,?,?)").run(id, projectId, canonicalTask.label, canonicalTask.type, "queued", "researching", canonicalTask.detail || null, "[]");
  touchProject(db, projectId);
  return id;
}

export function markResearchAccepted(
  db: Database.Database,
  projectId: string,
  taskId: string,
  note?: string,
  source: "vbk" | "web" | "user" = "user",
) {
  const evidence = [{ id: randomUUID(), title: note?.trim() || "运营人员已完成平台核查", source, retrievedAt: now(), accepted: true }];
  db.prepare("UPDATE research_tasks SET state='confirmed', status='succeeded', evidence_json=? WHERE id=? AND project_id=?")
    .run(JSON.stringify(evidence), taskId, projectId);
  touchProject(db, projectId);
}

export function markResearchTasksSatisfied(
  db: Database.Database,
  projectId: string,
  taskIds: readonly string[],
  note = "当前产品草稿已有本地字段，待处理事项刷新后自动确认",
) {
  const ids = [...new Set(taskIds.filter(Boolean))];
  if (!ids.length) return { updated: 0, taskIds: [] as string[] };
  const evidence = JSON.stringify([{ id: randomUUID(), title: note, source: "user", retrievedAt: now(), accepted: true }]);
  const placeholders = ids.map(() => "?").join(",");
  const tx = db.transaction(() => {
    const before = db.prepare(`
      SELECT id FROM research_tasks
      WHERE project_id=? AND id IN (${placeholders}) AND state NOT IN ('confirmed','resolved')
    `).all(projectId, ...ids) as Array<{ id: string }>;
    if (!before.length) return { updated: 0, taskIds: [] as string[] };
    db.prepare(`
      UPDATE research_tasks
      SET state='confirmed', status='succeeded', evidence_json=?
      WHERE project_id=? AND id IN (${placeholders}) AND state NOT IN ('confirmed','resolved')
    `).run(evidence, projectId, ...ids);
    touchProject(db, projectId);
    return { updated: before.length, taskIds: before.map((row) => row.id) };
  });
  return tx();
}
