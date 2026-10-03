import type { AgentApproval, AgentSnapshot } from "../../shared/contracts.js";
import type { ProductWorkflowCoordinator } from "../application/product-workflow-coordinator.js";
import { approvalForRun } from "./integration-gates.js";

/** 排队完成后重新检查暂停和授权，不能用入队时的旧状态启动写入。 */
export async function runQueuedApprovedWorkflow(args: {
  id: string;
  approval: AgentApproval;
  coordinator: ProductWorkflowCoordinator;
  snapshot: () => AgentSnapshot | undefined;
  execute: () => Promise<void>;
  complete: () => Promise<unknown> | undefined;
  pause: (message: string) => Promise<unknown> | undefined;
}): Promise<void> {
  try {
    const started = await args.coordinator.runQueuedAutomation(args.id, async () => {
      const current = args.snapshot();
      if (current?.run?.status !== "running" || approvalForRun(current)?.id !== args.approval.id) return false;
      await args.execute();
      return true;
    });
    if (started) await args.complete();
    else await args.pause("排队期间任务已暂停或授权已变化，未开始平台写入。");
  } catch (error) {
    await args.pause(error instanceof Error ? error.message : String(error));
  }
}
