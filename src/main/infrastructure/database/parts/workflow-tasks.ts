import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import type {
  ProductSummary,
  ProductWorkflowTask,
  ProductWorkflowTaskStage,
  ProductWorkflowTaskStatus,
} from "../../../../shared/contracts.js";
import { now } from "./types.js";

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
  if (product.status !== "draft_saved" || !product.productId?.trim()) return undefined;
  const current = latestWorkflowTaskForProduct(db, product.id);
  if (!current || current.status === "abandoned" || current.status === "succeeded") return undefined;
  return updateWorkflowTask(db, current.id, {
    status: "succeeded",
    stage: "completed",
    progress: 100,
    message: "携程草稿已保存，后台任务已完成",
    error: undefined,
    completedAt: now(),
  });
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

/** 应用退出时正在执行的任务不能伪装成继续运行；保留记录并明确要求人工检查后重试。 */
export function recoverOrphanWorkflowTasks(db: Database.Database): ProductWorkflowTask[] {
  const running = listWorkflowTasks(db).filter((task) => task.status === "running");
  return running.map((task) => updateWorkflowTask(db, task.id, {
    status: "needs_attention",
    message: "应用上次退出时任务仍在运行，请打开产品核对当前阶段",
    error: "任务因应用退出而中断",
    completedAt: now(),
  }));
}
