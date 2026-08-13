import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import type { ResearchTask } from "../../../../shared/contracts.js";
import {
  canonicalPoiResearchTaskLabel,
  isSamePoiResearchTask,
} from "../../../../shared/poi-research-tasks.js";
import { isResearchTaskSatisfiedByProduct } from "../../../../shared/research-task-satisfaction.js";
import { isCoverResearchTaskSatisfiedByProduct } from "../../../minimax/minimax-constants.js";
import { now } from "./types.js";
import { touchProduct } from "./products.js";

export function addResearchTask(db: Database.Database, localProductId: string, task: Pick<ResearchTask, "label" | "type" | "detail">) {
  const canonicalTask = {
    ...task,
    label: canonicalPoiResearchTaskLabel(task.label, task.type),
  };
  const existing = db.prepare(`
    SELECT id, label, type FROM research_tasks
    WHERE local_product_id=? AND type=?
  `).all(localProductId, canonicalTask.type) as Array<{ id: string; label: string; type: ResearchTask["type"] }>;
  const duplicate = existing.find((row) => row.label === canonicalTask.label)
    ?? existing.find((row) => isSamePoiResearchTask(row, canonicalTask));
  if (duplicate) {
    if (canonicalTask.detail && duplicate.label === canonicalTask.label) {
      db.prepare("UPDATE research_tasks SET detail=? WHERE id=?").run(canonicalTask.detail, duplicate.id);
    }
    touchProduct(db, localProductId);
    return duplicate.id;
  }
  const id = randomUUID();
  db.prepare("INSERT INTO research_tasks VALUES(?,?,?,?,?,?,?,?)").run(id, localProductId, canonicalTask.label, canonicalTask.type, "queued", "researching", canonicalTask.detail || null, "[]");
  touchProduct(db, localProductId);
  return id;
}

export function markResearchAccepted(
  db: Database.Database,
  localProductId: string,
  taskId: string,
  note?: string,
  source: "vbk" | "web" | "user" = "user",
) {
  const evidence = [{ id: randomUUID(), title: note?.trim() || "运营人员已完成平台核查", source, retrievedAt: now(), accepted: true }];
  db.prepare("UPDATE research_tasks SET state='confirmed', status='succeeded', evidence_json=? WHERE id=? AND local_product_id=?")
    .run(JSON.stringify(evidence), taskId, localProductId);
  touchProduct(db, localProductId);
}

export function markResearchTasksSatisfied(
  db: Database.Database,
  localProductId: string,
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
      WHERE local_product_id=? AND id IN (${placeholders}) AND state NOT IN ('confirmed','resolved')
    `).all(localProductId, ...ids) as Array<{ id: string }>;
    if (!before.length) return { updated: 0, taskIds: [] as string[] };
    db.prepare(`
      UPDATE research_tasks
      SET state='confirmed', status='succeeded', evidence_json=?
      WHERE local_product_id=? AND id IN (${placeholders}) AND state NOT IN ('confirmed','resolved')
    `).run(evidence, localProductId, ...ids);
    touchProduct(db, localProductId);
    return { updated: before.length, taskIds: before.map((row) => row.id) };
  });
  return tx();
}

/**
 * 持久化的 `research_tasks` 行级确认：扫描当前产品的 research task 列表，
 * **逐条**用 strict 谓词判断它是否已经被新写入的 product JSON 满足。
 * 严格按 task 的 label / type 与 product 字段一一对应：
 *   - vbk / web / cost：走 `isResearchTaskSatisfiedByProduct`（POI 名称匹配 +
 *     正整数 poiId / 商业字段 / 用车资源组 ID / 酒店档次等）；
 *   - image：走 `isCoverResearchTaskSatisfiedByProduct`（仅看
 *     `hasCompleteCtripLibraryCover`）；
 *   - 已经在 confirmed / resolved 的 task 跳过（避免覆盖已 accepted 的 evidence）；
 *   - 其它（label / type 不匹配任何谓词）的 task 一律不确认。
 *
 * 调用方应在外层使用 `db.transaction()` 把这次扫描与产品 JSON 写入原子化，
 * 否则会出现「product 已写入但 research_tasks 仍 queued / researching」的
 * 旧 bug：UI 乐观态显示 100% 而 `products:readiness` / 自动化 preflight 仍按
 * 持久化数据判定为阻塞。
 */
export function findSatisfiedResearchTaskIds(
  db: Database.Database,
  localProductId: string,
  product: Record<string, unknown>,
): string[] {
  const rows = db.prepare(`
    SELECT id, label, type, state
    FROM research_tasks
    WHERE local_product_id=?
  `).all(localProductId) as Array<{ id: string; label: string; type: ResearchTask["type"]; state: ResearchTask["state"] }>;
  const satisfied: string[] = [];
  for (const row of rows) {
    if (row.state === "confirmed" || row.state === "resolved") continue;
    const predicate = row.type === "image"
      ? isCoverResearchTaskSatisfiedByProduct
      : isResearchTaskSatisfiedByProduct;
    // 谓词对 image 类型已自带「只看 type === "image"」守卫；对 vbk / web / cost
    // 类型已自带「task.type === "image" → false」守卫（见 shared/research-task-
    // satisfaction.ts）。两侧守卫互补，按 type 选一侧谓词即可。
    if (predicate({ type: row.type, label: row.label }, product)) {
      satisfied.push(row.id);
    }
  }
  return satisfied;
}

export interface SatisfyResearchTasksByProductOptions {
  note?: string;
  /** 限定只确认这些 taskIds；为空时按 product 严格匹配。用于上层做更细的子集约束。 */
  onlyTaskIds?: readonly string[];
  source?: "vbk" | "web" | "user";
}

/**
 * 原子地把「当前 product 已满足」的 research task 标记为 confirmed / succeeded。
 *
 * 设计要点：
 *  - 调用方应在外层用 `db.transaction()` 把这次确认与 product JSON 写入打包，
 *    让 products.get / products.readiness / 自动化 preflight 看到一致状态；
 *  - 谓词复用 `findSatisfiedResearchTaskIds` 的严格匹配（不 blanket 确认
 *    所有 queued 行）；
 *  - 已经 confirmed / resolved 的 task 永远不会被覆盖（findSatisfiedResearchTaskIds
 *    跳过、markResearchTasksSatisfied 的 SQL 也再守一道）；
 *  - 缺 task 列表或全部已完成时返回 `{ updated: 0, taskIds: [] }`，不抛错。
 */
export function markResearchTasksSatisfiedByProduct(
  db: Database.Database,
  localProductId: string,
  product: Record<string, unknown>,
  options: SatisfyResearchTasksByProductOptions = {},
) {
  const matched = findSatisfiedResearchTaskIds(db, localProductId, product);
  const targetIds = options.onlyTaskIds && options.onlyTaskIds.length > 0
    ? matched.filter((id) => options.onlyTaskIds!.includes(id))
    : matched;
  if (targetIds.length === 0) return { updated: 0, taskIds: [] as string[] };
  // 仍然走 markResearchTasksSatisfied，保证 evidence 写入与「只动未 confirmed
  // / resolved 的行」两道守卫生效一致（不是把所有 queued 行一锅端）。
  return markResearchTasksSatisfied(
    db,
    localProductId,
    targetIds,
    options.note ?? "产品 JSON 写入时同步按字段匹配已满足，自动确认",
  );
}
