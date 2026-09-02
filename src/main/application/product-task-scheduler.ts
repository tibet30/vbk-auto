import { logError, logInfo } from "../../shared/log-timestamp.js";
import type {
  PlanningRunResult,
  ProductDetail,
  ProductWorkflowTask,
  WorkflowTaskRetryMode,
} from "../../shared/contracts.js";
import type { VbkDatabase } from "../infrastructure/database/database.js";
import {
  runAutoConfirmedCreation,
  type AutoConfirmedCreationStage,
  type AutoConfirmedProductDependencies,
} from "./auto-confirm-product.js";

export interface ProductTaskSchedulerDependencies extends AutoConfirmedProductDependencies {
  /** 用户从报错处继续规划时，允许重置耗尽的失败节点；应用退出恢复不使用它。 */
  retryPlanning?: (localProductId: string) => Promise<PlanningRunResult>;
  db: AutoConfirmedProductDependencies["db"] & Pick<VbkDatabase,
    | "abandonWorkflowTask"
    | "createWorkflowTask"
    | "getWorkflowTask"
    | "listWorkflowTasks"
    | "updateWorkflowTask">;
  emitTask(task: ProductWorkflowTask): void;
  emitProduct(product: ProductDetail): void;
}

const STAGE_PROGRESS: Record<AutoConfirmedCreationStage, number> = {
  planning: 8,
  readiness: 55,
  automation: 65,
};

const STAGE_MESSAGE: Record<AutoConfirmedCreationStage, string> = {
  planning: "正在生成并核验产品方案",
  readiness: "正在检查携程录入条件",
  automation: "正在逐阶段录入携程草稿",
};

const RETRY_FROM_ERROR_QUEUED_MESSAGE = "任务将从报错处继续执行";
const RETRY_FROM_ERROR_RUNNING_MESSAGE = "正在从报错处继续执行";
const RETRY_FROM_START_QUEUED_MESSAGE = "任务将从头开始执行";
const RETRY_FROM_START_RUNNING_MESSAGE = "正在从头开始执行";

/**
 * 一键创建的主进程调度器。enqueue 只落库并排入 microtask，不把长流程
 * Promise 返给 renderer；页面切换、弹窗卸载均不会中断执行。
 */
export class ProductTaskScheduler {
  private readonly active = new Set<string>();

  constructor(private readonly dependencies: ProductTaskSchedulerDependencies) {}

  /**
   * 永久废弃任务。状态先落库并广播，再请求自动录入在安全检查点停止；
   * 规划阶段无法强制打断网络请求，但返回后不会继续 readiness / automation。
   */
  async abandon(taskId: string): Promise<ProductWorkflowTask> {
    const current = this.dependencies.db.getWorkflowTask(taskId);
    if (!current) throw new Error(`后台任务不存在：${taskId}`);
    if (current.status === "abandoned") return current;
    const abandoned = this.dependencies.db.abandonWorkflowTask(taskId);
    this.dependencies.emitTask(abandoned);
    if (current.status === "running" && current.stage === "automation") {
      try {
        await this.dependencies.automation.stop?.(current.localProductId);
      } catch (error) {
        logError("[product-task] failed to request automation stop after abandonment", {
          taskId,
          localProductId: current.localProductId,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    logInfo("[product-task] abandoned", {
      taskId,
      localProductId: current.localProductId,
      previousStatus: current.status,
      previousStage: current.stage,
    });
    return abandoned;
  }

  enqueue(product: ProductDetail): ProductWorkflowTask {
    const task = this.dependencies.db.createWorkflowTask(product.id, product.name);
    this.dependencies.emitTask(task);
    queueMicrotask(() => { void this.run(task.id); });
    return task;
  }

  /**
   * 用户主动重试一个停在报错处的任务：可以沿用原阶段，也可以从规划起点
   * 重新执行。后者会由 startPlanning 重置远端规划并重跑后续链路。
   */
  async resume(taskId: string, mode: WorkflowTaskRetryMode): Promise<ProductWorkflowTask> {
    const current = this.dependencies.db.getWorkflowTask(taskId);
    if (!current) throw new Error(`后台任务不存在：${taskId}`);
    if (current.status !== "needs_attention" && current.status !== "failed") {
      throw new Error("只有需要处理或执行失败的任务可以重新执行。");
    }
    if (mode === "from_error" && (current.stage === "queued" || current.stage === "completed")) {
      throw new Error("该任务没有可继续的报错阶段。");
    }
    const fromStart = mode === "from_start";
    const queued = this.persist(taskId, {
      status: "queued",
      ...(fromStart ? { stage: "planning", progress: 0 } : {}),
      message: fromStart ? RETRY_FROM_START_QUEUED_MESSAGE : RETRY_FROM_ERROR_QUEUED_MESSAGE,
      error: undefined,
      completedAt: undefined,
    });
    queueMicrotask(() => { void this.run(taskId); });
    return queued;
  }

  resumeQueued(): void {
    for (const task of this.dependencies.db.listWorkflowTasks()) {
      if (task.status === "queued") queueMicrotask(() => { void this.run(task.id); });
    }
  }

  private persist(
    taskId: string,
    patch: Parameters<VbkDatabase["updateWorkflowTask"]>[1],
  ): ProductWorkflowTask {
    const current = this.dependencies.db.getWorkflowTask(taskId);
    if (!current) throw new Error(`后台任务不存在：${taskId}`);
    // 永久废弃是不可逆终态；迟到的规划/自动化回调不得覆盖它。
    if (current.status === "abandoned") return current;
    const task = this.dependencies.db.updateWorkflowTask(taskId, patch);
    this.dependencies.emitTask(task);
    return task;
  }

  private async run(taskId: string): Promise<void> {
    if (this.active.has(taskId)) return;
    const task = this.dependencies.db.getWorkflowTask(taskId);
    if (!task || task.status !== "queued") return;
    const retryingFromStart = task.message === RETRY_FROM_START_QUEUED_MESSAGE;
    const resumeFrom = retryingFromStart || task.stage === "queued" ? "planning" : task.stage;
    if (resumeFrom === "completed") return;
    const resuming = task.stage !== "queued" && !retryingFromStart;
    const retryingFromError = task.message === RETRY_FROM_ERROR_QUEUED_MESSAGE;
    this.active.add(taskId);
    const started = this.persist(taskId, {
      status: "running",
      stage: resumeFrom,
      progress: resuming ? task.progress : 5,
      message: resuming
        ? (retryingFromError ? RETRY_FROM_ERROR_RUNNING_MESSAGE : "任务因应用退出而中断，正在从原阶段继续")
        : (retryingFromStart ? RETRY_FROM_START_RUNNING_MESSAGE : "任务已开始，准备生成产品方案"),
      startedAt: new Date().toISOString(),
      error: undefined,
    });
    if (started.status === "abandoned") {
      this.active.delete(taskId);
      return;
    }
    logInfo("[product-task] started", { taskId, localProductId: task.localProductId });
    try {
      const executionDependencies = retryingFromError && resumeFrom === "planning" && this.dependencies.retryPlanning
        ? { ...this.dependencies, resumePlanning: this.dependencies.retryPlanning }
        : this.dependencies;
      const result = await runAutoConfirmedCreation(
        executionDependencies,
        task.localProductId,
        (stage) => this.persist(taskId, {
          status: "running",
          stage,
          progress: STAGE_PROGRESS[stage],
          message: STAGE_MESSAGE[stage],
        }),
        () => this.dependencies.db.getWorkflowTask(taskId)?.status === "abandoned",
        { resumeFrom, resumePlanning: resuming && resumeFrom === "planning" },
      );
      if (result.status === "abandoned") {
        return;
      }
      if (result.status === "needs_attention") {
        this.persist(taskId, {
          status: "needs_attention",
          stage: result.stage,
          progress: result.stage === "planning" ? 45 : result.stage === "readiness" ? 60 : 85,
          message: "任务已暂停，请打开产品处理待确认项",
          error: result.message,
          completedAt: new Date().toISOString(),
        });
      } else {
        this.persist(taskId, {
          status: "succeeded",
          stage: "completed",
          progress: 100,
          message: result.message,
          error: undefined,
          completedAt: new Date().toISOString(),
        });
      }
    } catch (error) {
      if (this.dependencies.db.getWorkflowTask(taskId)?.status === "abandoned") return;
      const message = error instanceof Error ? error.message : "后台任务执行失败";
      this.persist(taskId, {
        status: "failed",
        message: "任务执行失败，请打开产品查看原因",
        error: message,
        completedAt: new Date().toISOString(),
      });
      logError("[product-task] failed", { taskId, localProductId: task.localProductId, message });
    } finally {
      this.active.delete(taskId);
      const product = this.dependencies.db.getProduct(task.localProductId);
      if (product) this.dependencies.emitProduct(product);
    }
  }
}
