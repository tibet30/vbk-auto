import type { ProductWorkflowTask } from "../../shared/contracts.js";
import type { AgentAttentionNotification } from "./agent-attention-notification.js";

/** Convert background workflow blockers into native-notification copy. */
export function workflowAttentionNotification(
  task: ProductWorkflowTask,
): AgentAttentionNotification | null {
  if (task.status === "needs_attention") {
    return {
      key: `${task.id}:attention:${task.updatedAt}:${task.message}`,
      title: `${task.productName}需要你的处理`,
      body: task.message || "任务正在等待你处理，打开应用查看详情。",
    };
  }

  if (task.status === "failed") {
    return {
      key: `${task.id}:failed:${task.updatedAt}:${task.error ?? task.message}`,
      title: `${task.productName}执行失败`,
      body: task.error || task.message || "执行过程中发生错误，打开应用查看详情。",
    };
  }

  return null;
}
