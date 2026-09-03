import type { PlanningRunResult, ProductDetail, ProductReadiness } from "../../shared/contracts.js";

export interface AutoConfirmedProductDependencies {
  startPlanning?: (localProductId: string) => Promise<PlanningRunResult>;
  resumePlanning?: (localProductId: string) => Promise<PlanningRunResult>;
  readiness: (
    localProductId: string,
    options?: {
      ignoreInterruptedAutomationFailure?: boolean;
      ignoreCurrentAutomationFailure?: boolean;
    },
  ) => ProductReadiness;
  productWorkflows: {
    runExclusive<T>(localProductId: string, kind: string, task: () => Promise<T>): Promise<T>;
  };
  automation: {
    start(localProductId: string): Promise<void>;
    stop?(localProductId: string): Promise<void>;
  };
  db: {
    getProduct(localProductId: string): ProductDetail | undefined;
    addMessage(localProductId: string, role: "assistant", content: string, status: "failed"): string;
    updateProduct(localProductId: string, product: Record<string, unknown>, status: "blocked"): void;
  };
}

export type AutoConfirmedCreationStage = "planning" | "readiness" | "automation";
export type AutoConfirmedCreationResult =
  | { status: "succeeded"; message: string }
  | { status: "needs_attention"; message: string; stage: "planning" | "readiness" | "automation" }
  | { status: "abandoned" };

export interface AutoConfirmedCreationOptions {
  resumeFrom?: AutoConfirmedCreationStage;
  resumePlanning?: boolean;
}

function automationAttentionMessage(product: ProductDetail | undefined): string {
  const run = product?.automation;
  const recovery = run?.recovery
    ? Object.values(run.recovery.phases).find((phase) => phase.state === "needs_user")
    : undefined;
  const warning = run?.logs.slice().reverse().find((entry) => entry.level !== "info")?.message;
  return recovery?.finalError
    || recovery?.userInstruction
    || warning
    || (run?.status === "cancelled" ? "自动录入已取消" : "携程草稿未通过完成核验");
}

/** 一键创建的主进程编排：生成完成且 readiness 通过，才允许启动 VBK 写入。 */
export async function runAutoConfirmedCreation(
  dependencies: AutoConfirmedProductDependencies,
  localProductId: string,
  onStage?: (stage: AutoConfirmedCreationStage) => void,
  shouldStop?: () => boolean,
  options: AutoConfirmedCreationOptions = {},
): Promise<AutoConfirmedCreationResult> {
  const resumeFrom = options.resumeFrom ?? "planning";
  if (shouldStop?.()) return { status: "abandoned" };
  if (resumeFrom === "planning") {
    const runPlanning = options.resumePlanning ? dependencies.resumePlanning : dependencies.startPlanning;
    if (!runPlanning) throw new Error("一键生成服务尚未就绪，请重启应用后重试。");
    onStage?.("planning");
    const planning = await runPlanning(localProductId);
    if (shouldStop?.()) return { status: "abandoned" };
    if (planning.status !== "completed") {
      // 规划器已经持久化了真实节点与状态；这里不能再根据尚未生成的字段覆盖成
      // “自动生成完成”的假失败，否则一键创建会丢失可恢复上下文。
      const reason = planning.rejected[0]?.reason || planning.assistantReply || "规划尚未完成";
      const current = dependencies.db.getProduct(localProductId);
      if (current) {
        dependencies.db.addMessage(
          localProductId,
          "assistant",
          `一键录入暂停：规划尚未完成。${reason}。已保留当前规划进度，解决该节点后会从此处续跑。`,
          "failed",
        );
      }
      return { status: "needs_attention", stage: "planning", message: reason };
    }
  }
  if (shouldStop?.()) return { status: "abandoned" };
  if (resumeFrom !== "automation") onStage?.("readiness");
  const readiness = dependencies.readiness(localProductId, {
    ignoreInterruptedAutomationFailure: resumeFrom === "automation",
    ignoreCurrentAutomationFailure: resumeFrom === "automation",
  });
  if (!readiness.ready) {
    const labels = readiness.issues.slice(0, 3).map((issue) => issue.label).join("、");
    const message = `自动生成完成，但仍有待确认项：${labels || "请打开产品查看详情"}。未开始录入携程。`;
    const current = dependencies.db.getProduct(localProductId);
    if (current) {
      dependencies.db.addMessage(localProductId, "assistant", message, "failed");
      dependencies.db.updateProduct(localProductId, current.product, "blocked");
    }
    return { status: "needs_attention", stage: "readiness", message };
  }
  if (shouldStop?.()) return { status: "abandoned" };
  onStage?.("automation");
  await dependencies.productWorkflows.runExclusive(localProductId, "automation", () =>
    dependencies.automation.start(localProductId));
  if (shouldStop?.()) return { status: "abandoned" };
  const completed = dependencies.db.getProduct(localProductId);
  if (completed?.automation?.status !== "succeeded" || completed.status !== "draft_saved") {
    return {
      status: "needs_attention",
      stage: "automation",
      message: automationAttentionMessage(completed),
    };
  }
  return { status: "succeeded", message: "方案已生成并完成携程草稿录入" };
}
