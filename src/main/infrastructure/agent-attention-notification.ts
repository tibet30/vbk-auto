import type { AgentSnapshot } from "../../shared/contracts.js";

export interface AgentAttentionNotification {
  key: string;
  title: string;
  body: string;
}

/** Returns a notification only for durable states that require user action. */
export function agentAttentionNotification(
  snapshot: AgentSnapshot,
  productName = "方案",
): AgentAttentionNotification | null {
  const run = snapshot.run;
  if (!run) return null;

  if (run.status === "waiting_input" && snapshot.pendingInput) {
    return {
      key: `${run.id}:input:${snapshot.pendingInput.id}`,
      title: `${productName}需要你的补充`,
      body: "AI 正在等待你补充信息，打开应用继续对话。",
    };
  }

  if (run.status === "waiting_approval" && snapshot.pendingApproval?.status === "pending") {
    return {
      key: `${run.id}:approval:${snapshot.pendingApproval.id}`,
      title: `${productName}等待确认`,
      body: "AI 已准备好方案，打开应用确认后继续。",
    };
  }

  if (run.status === "failed") {
    return {
      key: `${run.id}:failed:${run.updatedAt}:${run.error ?? ""}`,
      title: `${productName}需要处理`,
      body: run.error || "AI 对话执行失败，打开应用查看并处理。",
    };
  }

  return null;
}
