/**
 * 同一产品的长流程互斥协调器。
 *
 * Renderer 的 disabled 只能改善交互，不能阻止双击、恢复任务或直接 IPC
 * 并发。主进程必须以产品为粒度串行化会写 product_json / workflow state 的
 * AI 与规划流程，避免两条链路基于旧快照互相覆盖。
 */

export type ProductWorkflow = "ai" | "planning" | "automation" | "resource" | "manual";

const WORKFLOW_LABELS: Record<ProductWorkflow, string> = {
  ai: "AI 对话",
  planning: "产品规划",
  automation: "VBK 自动录入",
  resource: "VBK 资源核查",
  manual: "运营手工编辑",
};

export class ProductWorkflowCoordinator {
  private readonly active = new Map<string, ProductWorkflow>();
  /**
   * 所有产品最终共用同一个已登录 VBK WebContentsView。产品级互斥只能保护
   * 本地 JSON，不能阻止不同产品同时 page.goto / evaluate。用一条 FIFO promise
   * 链只串行真正占用 VBK 页面的操作；纯 AI 规划仍可跨产品并行。
   */
  private vbkPageTail: Promise<void> = Promise.resolve();

  activeWorkflow(localProductId: string): ProductWorkflow | undefined {
    return this.active.get(localProductId);
  }

  assertIdle(localProductId: string, requested: ProductWorkflow): void {
    const current = this.active.get(localProductId);
    if (!current) return;
    throw new Error(
      `${WORKFLOW_LABELS[current]}正在进行中，不能同时启动${WORKFLOW_LABELS[requested]}：${localProductId}`,
    );
  }

  async runExclusive<T>(
    localProductId: string,
    workflow: ProductWorkflow,
    task: () => Promise<T>,
  ): Promise<T> {
    this.assertIdle(localProductId, workflow);
    this.active.set(localProductId, workflow);
    try {
      return await task();
    } finally {
      if (this.active.get(localProductId) === workflow) this.active.delete(localProductId);
    }
  }

  async runVbkPageExclusive<T>(task: () => Promise<T>): Promise<T> {
    const previous = this.vbkPageTail;
    let release!: () => void;
    this.vbkPageTail = new Promise<void>((resolve) => { release = resolve; });
    await previous.catch(() => undefined);
    try {
      return await task();
    } finally {
      release();
    }
  }
}
