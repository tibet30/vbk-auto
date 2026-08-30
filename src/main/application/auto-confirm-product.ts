import type { PlanningRunResult, ProductDetail, ProductReadiness } from "../../shared/contracts.js";

export interface AutoConfirmedProductDependencies {
  startPlanning?: (localProductId: string) => Promise<PlanningRunResult>;
  readiness: (localProductId: string) => ProductReadiness;
  productWorkflows: {
    runExclusive<T>(localProductId: string, kind: string, task: () => Promise<T>): Promise<T>;
  };
  automation: { start(localProductId: string): Promise<void> };
  db: {
    getProduct(localProductId: string): ProductDetail | undefined;
    addMessage(localProductId: string, role: "assistant", content: string, status: "failed"): string;
    updateProduct(localProductId: string, product: Record<string, unknown>, status: "blocked"): void;
  };
}

/** 一键创建的主进程编排：生成完成且 readiness 通过，才允许启动 VBK 写入。 */
export async function runAutoConfirmedCreation(
  dependencies: AutoConfirmedProductDependencies,
  localProductId: string,
): Promise<void> {
  if (!dependencies.startPlanning) throw new Error("一键生成服务尚未就绪，请重启应用后重试。");
  await dependencies.startPlanning(localProductId);
  const readiness = dependencies.readiness(localProductId);
  if (!readiness.ready) {
    const labels = readiness.issues.slice(0, 3).map((issue) => issue.label).join("、");
    const message = `自动生成完成，但仍有待确认项：${labels || "请打开产品查看详情"}。未开始录入携程。`;
    const current = dependencies.db.getProduct(localProductId);
    if (current) {
      dependencies.db.addMessage(localProductId, "assistant", message, "failed");
      dependencies.db.updateProduct(localProductId, current.product, "blocked");
    }
    return;
  }
  await dependencies.productWorkflows.runExclusive(localProductId, "automation", () =>
    dependencies.automation.start(localProductId));
}
