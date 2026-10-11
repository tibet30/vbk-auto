import type { AgentSnapshot, ProductDetail, ProductWorkflowTask, WorkflowTaskRetryMode } from '../../shared/contracts.js';
import type { ProductExecutionStore } from './product-execution-service.js';
import { logError } from '../../shared/log-timestamp.js';

export interface ProductTaskSchedulerDependencies {
  db: ProductExecutionStore & {
    getWorkflowTask(id: string): ProductWorkflowTask | undefined;
    listWorkflowTasks(): ProductWorkflowTask[];
    abandonWorkflowTask(id: string): ProductWorkflowTask;
  };
  agent: {
    get(id: string): Promise<AgentSnapshot>;
    send(id: string, content: string): Promise<AgentSnapshot>;
    resume(id: string): Promise<AgentSnapshot>;
    abandon(id: string): Promise<AgentSnapshot>;
  };
  emitTask(task: ProductWorkflowTask): void;
  emitProduct(product: ProductDetail): void;
}

/** Task management facade. All execution belongs to the durable Agent loop. */
export class ProductTaskScheduler {
  constructor(private readonly deps: ProductTaskSchedulerDependencies) {}
  enqueue(product: ProductDetail): ProductWorkflowTask {
    const task = this.deps.db.createWorkflowTask(product.id, product.name);
    this.deps.emitTask(task);
    queueMicrotask(() => {
      void this.deps.agent.send(product.id,
        '请基于当前产品完成本地规划与资源核验；任何 VBK 写入都必须先请求明确审批。')
        .catch(error => this.fail(task.id, error));
    });
    return task;
  }
  async resume(taskId: string, mode: WorkflowTaskRetryMode): Promise<ProductWorkflowTask> {
    const task = this.requireTask(taskId);
    if (!['needs_attention', 'failed'].includes(task.status)) throw new Error('只有需要处理或执行失败的任务可以重新执行。');
    const product = this.deps.db.getProduct(task.localProductId);
    if (mode === 'from_start' && product?.productId) throw new Error('产品已进入 VBK 录入，不能从头重新规划。');
    const snapshot = await this.deps.agent.get(task.localProductId);
    const active = snapshot.run && !['completed', 'abandoned'].includes(snapshot.run.status);
    if (mode === 'from_start' && active) throw new Error('当前产品由 Agent 管理，请在对话中明确要求从头重新规划。');
    this.deps.db.updateWorkflowTask(taskId, { retryMode: mode });
    if (active) await this.deps.agent.resume(task.localProductId);
    else await this.deps.agent.send(task.localProductId, mode === 'from_start'
      ? '请基于当前产品从头重新规划。先读取产品和必要资源；有写入前请求明确审批。' : '继续');
    return this.deps.db.getWorkflowTask(taskId) ?? task;
  }
  async abandon(taskId: string): Promise<ProductWorkflowTask> {
    const current = this.requireTask(taskId);
    if (current.status === 'abandoned') return current;
    const task = this.deps.db.abandonWorkflowTask(taskId);
    this.deps.emitTask(task);
    await this.deps.agent.abandon(current.localProductId);
    return task;
  }
  resumeQueued(): void {
    for (const task of this.deps.db.listWorkflowTasks()) {
      if (task.status !== 'queued') continue;
      void this.deps.agent.get(task.localProductId).then(async snapshot => {
        if (snapshot.run && ['queued', 'running'].includes(snapshot.run.status)) await this.deps.agent.resume(task.localProductId);
        else this.fail(task.id, new Error('请在方案协作中继续当前任务。'));
      }).catch(error => this.fail(task.id, error));
    }
  }
  private requireTask(id: string): ProductWorkflowTask {
    const task = this.deps.db.getWorkflowTask(id);
    if (!task) throw new Error(`后台任务不存在：${id}`);
    return task;
  }
  private fail(id: string, error: unknown): void {
    const current = this.deps.db.getWorkflowTask(id);
    if (!current || current.status === 'abandoned') return;
    const message = error instanceof Error ? error.message : String(error);
    this.deps.emitTask(this.deps.db.updateWorkflowTask(id, {
      status: 'needs_attention', error: message, message: '任务已暂停，请打开产品继续处理',
    }));
    logError('[product-task] Agent dispatch failed', { taskId: id, message });
  }
}
