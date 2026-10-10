import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import type {
  ProductSummary,
  ProductWorkflowTask,
  ProductWorkflowTaskStage,
  ProductWorkflowTaskStatus,
} from "../../../../shared/contracts.js";
import { now } from "./types.js";
import { incompleteTrafficVariants, isTrafficLineRouteReviewRequired, isUnavailableTrafficResourceFailure } from "../../../../shared/traffic-resource-status.js";

const ROUTE_REVIEW_MESSAGE = "母产品草稿已保存；交通套餐待玩法线路匹配审核，审核通过后继续";
const LEGACY_SUPERSEDED_TASK_MESSAGE = "同名的新产品已完成录入，本历史任务已收敛";

type WorkflowTaskRow = {
  id: string;
  local_product_id: string;
  product_name: string;
  status: ProductWorkflowTaskStatus;
  stage: ProductWorkflowTaskStage;
  progress: number;
  message: string;
  error: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  completed_at: string | null;
};

function fromRow(row: WorkflowTaskRow): ProductWorkflowTask {
  return {
    id: row.id,
    localProductId: row.local_product_id,
    productName: row.product_name,
    status: row.status,
    stage: row.stage,
    progress: row.progress,
    message: row.message,
    ...(row.error ? { error: row.error } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.started_at ? { startedAt: row.started_at } : {}),
    ...(row.completed_at ? { completedAt: row.completed_at } : {}),
  };
}

export function createWorkflowTask(
  db: Database.Database,
  localProductId: string,
  productName: string,
): ProductWorkflowTask {
  const timestamp = now();
  const task: ProductWorkflowTask = {
    id: randomUUID(),
    localProductId,
    productName,
    status: "queued",
    stage: "queued",
    progress: 0,
    message: "任务已创建，等待开始",
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  db.prepare(`
    INSERT INTO workflow_tasks(
      id,local_product_id,product_name,status,stage,progress,message,error,
      created_at,updated_at,started_at,completed_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    task.id, task.localProductId, task.productName, task.status, task.stage,
    task.progress, task.message, null, task.createdAt, task.updatedAt, null, null,
  );
  return task;
}

export function getWorkflowTask(db: Database.Database, id: string): ProductWorkflowTask | undefined {
  const row = db.prepare("SELECT * FROM workflow_tasks WHERE id=?").get(id) as WorkflowTaskRow | undefined;
  return row ? fromRow(row) : undefined;
}

export function latestWorkflowTaskForProduct(
  db: Database.Database,
  localProductId: string,
): ProductWorkflowTask | undefined {
  const row = db.prepare(`
    SELECT * FROM workflow_tasks WHERE local_product_id=?
    ORDER BY created_at DESC, id DESC LIMIT 1
  `).get(localProductId) as WorkflowTaskRow | undefined;
  return row ? fromRow(row) : undefined;
}

export function listWorkflowTasks(db: Database.Database): ProductWorkflowTask[] {
  return (db.prepare("SELECT * FROM workflow_tasks ORDER BY created_at DESC, id DESC").all() as WorkflowTaskRow[])
    .map(fromRow);
}

export function updateWorkflowTask(
  db: Database.Database,
  id: string,
  patch: Partial<Pick<ProductWorkflowTask,
    "status" | "stage" | "progress" | "message" | "error" | "startedAt" | "completedAt">>,
): ProductWorkflowTask {
  const current = getWorkflowTask(db, id);
  if (!current) throw new Error(`后台任务不存在：${id}`);
  // 永久废弃不可逆；成功也不能被迟到回调回退，但仍允许用户显式把已完成的
  // 历史任务永久废弃。
  if (
    (current.status === "abandoned" && patch.status !== "abandoned")
    || (current.status === "succeeded" && patch.status !== "succeeded" && patch.status !== "abandoned")
  ) return current;
  const next: ProductWorkflowTask = {
    ...current,
    ...patch,
    progress: Math.max(0, Math.min(100, Math.round(patch.progress ?? current.progress))),
    updatedAt: now(),
  };
  db.prepare(`
    UPDATE workflow_tasks SET
      status=?, stage=?, progress=?, message=?, error=?, updated_at=?, started_at=?, completed_at=?
    WHERE id=?
  `).run(
    next.status, next.stage, next.progress, next.message, next.error ?? null,
    next.updatedAt, next.startedAt ?? null, next.completedAt ?? null, id,
  );
  return next;
}

/**
 * 产品的远端草稿成功态是任务完成的最终证据。后续手工补齐或恢复流程也可能
 * 达到该状态，因此需要把最近一条非废弃任务收敛为成功，而不能永远保留早先
 * 的 planning/readiness 告警。
 */
export function completeWorkflowTaskForProduct(
  db: Database.Database,
  product: Pick<ProductSummary, "id" | "status" | "productId">,
): ProductWorkflowTask | undefined {
  // 母草稿是母产品成功证据。仍暂停在必需线路审核的 Agent 不能被启动收敛
  // 掩盖为全部完成；普通可售资源跳过/已完成 Agent 仍保留原收敛规则。
  if (product.status !== "draft_saved" || !product.productId?.trim()) return undefined;
  const current = latestWorkflowTaskForProduct(db, product.id);
  if (!current || current.status === "abandoned") return undefined;
  const pendingTraffic = pendingTrafficWorkflow(db, product.id);
  if (pendingTraffic) {
    if (current.status === pendingTraffic.status && current.message === pendingTraffic.message && current.progress < 100) return undefined;
    // 权威补偿仅针对仍暂停、且实际子产品回读未完成的线路审核；不能作为
    // 普通迟到回调回退 succeeded 的通道。
    db.prepare(`UPDATE workflow_tasks SET status=?,stage='automation',
      progress=MIN(progress,99),message=?,error=NULL,completed_at=NULL,updated_at=? WHERE id=?`)
      .run(pendingTraffic.status, pendingTraffic.message, now(), current.id);
    return getWorkflowTask(db, current.id);
  }
  if (current.status === "succeeded") return undefined;
  return updateWorkflowTask(db, current.id, {
    status: "succeeded",
    stage: "completed",
    progress: 100,
    message: "携程草稿已保存，后台任务已完成",
    error: undefined,
    completedAt: now(),
  });
}

function pendingTrafficWorkflow(db: Database.Database, productId: string): { status: "running" | "needs_attention"; message: string } | undefined {
  const snapshotRow = db.prepare("SELECT snapshot_json FROM agent_snapshots WHERE local_product_id=?").get(productId) as { snapshot_json: string } | undefined;
  if (!snapshotRow) return undefined;
  const snapshot = JSON.parse(snapshotRow.snapshot_json);
  if (snapshot.run?.status === "abandoned") return undefined;
  const row = db.prepare("SELECT payload_json FROM automation_runs WHERE local_product_id=? ORDER BY updated_at DESC LIMIT 1")
    .get(productId) as { payload_json: string } | undefined;
  if (!row) return undefined;
  const automation = JSON.parse(row.payload_json);
  const progress = automation.trafficLine;
  const productRow = db.prepare("SELECT product_json FROM products WHERE id=?").get(productId) as { product_json: string } | undefined;
  const config = productRow ? JSON.parse(productRow.product_json).operations?.trafficLine : undefined;
  const incomplete = incompleteTrafficVariants(config, progress);
  if (incomplete.length) return { status: snapshot.run?.status === "running" ? "running" : "needs_attention",
    message: "母产品草稿已保存；交通套餐尚未通过最终回读，继续交通阶段" };
  const children = progress?.children;
  if (!Array.isArray(children)) return undefined;
  if (snapshot.run?.status === "running" && children.some(child => child?.verified !== true && child?.skipped !== true)) {
    return { status: "running", message: "母产品草稿已保存；正在完成交通套餐并核查最终回读" };
  }
  if (children.some(child => child?.verified !== true
    && isTrafficLineRouteReviewRequired(String(child?.failureReason ?? "")))) {
    return { status: "needs_attention", message: ROUTE_REVIEW_MESSAGE };
  }
  if (children.some(child => child?.verified !== true && child?.skipped !== true && child?.failureReason
    && !isUnavailableTrafficResourceFailure(String(child.failureReason), child.variant))) {
    return { status: "needs_attention", message: "母产品草稿已保存；交通套餐尚未通过最终回读，处理失败后继续" };
  }
  return undefined;
}

/** 启动或任务列表刷新时修复已经保存草稿但仍残留旧告警的任务。 */
export function completeSavedProductWorkflowTasks(db: Database.Database): ProductWorkflowTask[] {
  const products = db.prepare(`
    SELECT id,status,product_id AS productId FROM products
    WHERE status='draft_saved' AND product_id IS NOT NULL AND TRIM(product_id)<>''
  `).all() as Array<Pick<ProductSummary, "id" | "status" | "productId">>;
  return products.flatMap((product) => {
    const completed = completeWorkflowTaskForProduct(db, product);
    return completed ? [completed] : [];
  });
}

/**
 * A planning retry can produce a replacement local product.  The old task is
 * still useful audit history, but must not remain actionable when a newer
 * product with the same deduplicated name has a saved remote draft.
 */
export function reconcileSupersededWorkflowTasks(db: Database.Database): ProductWorkflowTask[] {
  const rows = db.prepare(`
    SELECT task.id, (
      SELECT replacement.product_id
      FROM products AS replacement
      WHERE replacement.name = task.product_name
        AND replacement.id <> task.local_product_id
        AND replacement.status = 'draft_saved'
        AND replacement.product_id IS NOT NULL
        AND TRIM(replacement.product_id) <> ''
        AND replacement.created_at >= task.created_at
      ORDER BY replacement.created_at ASC, replacement.id ASC
      LIMIT 1
    ) AS replacement_product_id
    FROM workflow_tasks AS task
    WHERE (
      task.status IN ('needs_attention', 'failed')
      OR (task.status = 'succeeded' AND task.message = ?)
    )
      AND EXISTS (
        SELECT 1
        FROM products AS replacement
        WHERE replacement.name = task.product_name
          AND replacement.id <> task.local_product_id
          AND replacement.status = 'draft_saved'
          AND replacement.product_id IS NOT NULL
          AND TRIM(replacement.product_id) <> ''
          AND replacement.created_at >= task.created_at
      )
    ORDER BY task.created_at ASC, task.id ASC
  `).all(LEGACY_SUPERSEDED_TASK_MESSAGE) as Array<{ id: string; replacement_product_id: string }>;
  return rows.map(({ id, replacement_product_id }) => updateWorkflowTask(db, id, {
    status: "succeeded",
    stage: "completed",
    progress: 100,
    message: `已由新草稿 ${replacement_product_id} 接管；历史失败壳保留作追溯`,
    error: undefined,
    completedAt: now(),
  }));
}

/** 永久封存任务。幂等调用保持首个废弃终态，不删除关联产品或执行记录。 */
export function abandonWorkflowTask(
  db: Database.Database,
  id: string,
): ProductWorkflowTask {
  const current = getWorkflowTask(db, id);
  if (!current) throw new Error(`后台任务不存在：${id}`);
  if (current.status === "abandoned") return current;
  return updateWorkflowTask(db, id, {
    status: "abandoned",
    message: "任务已永久废弃",
    error: undefined,
    completedAt: now(),
  });
}

/**
 * 应用退出会丢失内存中的执行器与锁，因此上次留下的 running 不能
 * 继续伪装成正在运行。将它们重新放回持久化队列，待浏览器与登录态恢复后
 * 由 ProductTaskScheduler 通过幂等的规划/自动化入口续跑。
 */
export function recoverOrphanWorkflowTasks(db: Database.Database): ProductWorkflowTask[] {
  const recoverable = listWorkflowTasks(db).filter((task) =>
    task.status === "running"
    // 兼容旧版本：它曾把同一种退出中断写成人工处理终态。
    || (task.status === "needs_attention" && task.error === "任务因应用退出而中断"));
  return recoverable.map((task) => updateWorkflowTask(db, task.id, {
    status: "queued",
    message: "任务因应用退出而中断，将在启动后继续",
    error: undefined,
    completedAt: undefined,
  }));
}
