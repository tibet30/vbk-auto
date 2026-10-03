/**
 * 同一产品的长流程互斥协调器。
 *
 * Renderer 的 disabled 只能改善交互，不能阻止双击、恢复任务或直接 IPC
 * 并发。主进程必须以产品为粒度串行化会写 product_json / workflow state 的
 * AI 与规划流程，避免两条链路基于旧快照互相覆盖。
 */

import { trackProductExecution, waitWithoutExecutionTime } from "../operations/product-execution-clock.js";

export type ProductWorkflow = "ai" | "planning" | "automation" | "resource" | "manual";

const WORKFLOW_LABELS: Record<ProductWorkflow, string> = {
  ai: "AI 对话",
  planning: "产品规划",
  automation: "VBK 自动录入",
  resource: "VBK 资源核查",
  manual: "运营手工编辑",
};

const VBK_PAGE_WORKFLOWS = new Set<ProductWorkflow>(["automation", "resource"]);

export class ProductWorkflowCoordinator {
  private readonly active = new Map<string, ProductWorkflow>();
  /**
   * 所有产品最终共用同一个已登录 VBK WebContentsView。产品级互斥只能保护
   * 本地 JSON，不能阻止不同产品同时 page.goto / evaluate。用一条 FIFO promise
   * 链只串行真正占用 VBK 页面的操作；纯 AI 规划仍可跨产品并行。
   */
  private vbkPageTail: Promise<void> = Promise.resolve();
  /** 当前长占用 VBK 页面的产品（automation / resource）；登录切换必须让路。 */
  private pageOwner?: { localProductId: string; workflow: ProductWorkflow };
  private pageWorkflowTail: Promise<void> = Promise.resolve();
  private pageOwnerReleased: Promise<void> = Promise.resolve();
  private readonly queued = new Set<string>();

  activeWorkflow(localProductId: string): ProductWorkflow | undefined {
    return this.active.get(localProductId);
  }

  vbkPageOwner(): { localProductId: string; workflow: ProductWorkflow } | undefined {
    return this.pageOwner;
  }

  assertIdle(localProductId: string, requested: ProductWorkflow): void {
    if (this.queued.has(localProductId)) throw new Error(`该产品已在等待 VBK 页面：${localProductId}`);
    const current = this.active.get(localProductId);
    if (!current) return;
    throw new Error(
      `${WORKFLOW_LABELS[current]}正在进行中，不能同时启动${WORKFLOW_LABELS[requested]}：${localProductId}`,
    );
  }

  assertVbkPageIdle(action: string): void {
    if (!this.pageOwner) return;
    throw new Error(
      `${WORKFLOW_LABELS[this.pageOwner.workflow]}正在占用 VBK 页面，不能${action}`,
    );
  }

  async runExclusive<T>(
    localProductId: string,
    workflow: ProductWorkflow,
    task: () => Promise<T>,
  ): Promise<T> {
    this.assertIdle(localProductId, workflow);
    if (VBK_PAGE_WORKFLOWS.has(workflow)) this.assertVbkPageIdle(`启动${WORKFLOW_LABELS[workflow]}`);
    this.active.set(localProductId, workflow);
    let releasePage: (() => void) | undefined;
    if (VBK_PAGE_WORKFLOWS.has(workflow)) {
      this.pageOwnerReleased = new Promise<void>(resolve => { releasePage = resolve; });
    }
    if (VBK_PAGE_WORKFLOWS.has(workflow)) this.pageOwner = { localProductId, workflow };
    try {
      return await (workflow === "manual" ? task() : trackProductExecution(localProductId, task));
    } finally {
      if (this.pageOwner?.localProductId === localProductId && this.pageOwner.workflow === workflow) {
        this.pageOwner = undefined;
      }
      if (this.active.get(localProductId) === workflow) this.active.delete(localProductId);
      releasePage?.();
    }
  }

  /** 授权录入按 FIFO 等待共享页面；排队也锁住本产品，防止方案被并发改写。 */
  async runQueuedAutomation<T>(localProductId: string, task: () => Promise<T>): Promise<T> {
    this.assertIdle(localProductId, "automation");
    this.queued.add(localProductId);
    const previous = this.pageWorkflowTail;
    let release!: () => void;
    const reservation = new Promise<void>(resolve => { release = resolve; });
    this.pageWorkflowTail = reservation;
    try {
      await waitWithoutExecutionTime(async () => {
        await previous;
        // Another resource operation may have acquired the page while waiting.
        while (this.pageOwner) await this.pageOwnerReleased;
      });
      this.queued.delete(localProductId);
      return await this.runExclusive(localProductId, "automation", task);
    } finally {
      this.queued.delete(localProductId);
      release();
      if (this.pageWorkflowTail === reservation) this.pageWorkflowTail = Promise.resolve();
    }
  }

  async runVbkPageExclusive<T>(task: () => Promise<T>): Promise<T> {
    const previous = this.vbkPageTail;
    let release!: () => void;
    this.vbkPageTail = new Promise<void>((resolve) => { release = resolve; });
    await waitWithoutExecutionTime(() => previous.catch(() => undefined));
    try {
      return await task();
    } finally {
      release();
    }
  }
}
