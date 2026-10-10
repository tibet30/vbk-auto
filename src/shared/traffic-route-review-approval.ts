import type { AgentApproval, AgentSnapshot } from "./contracts-agent.js";

/** 只读取当前意图最后一次用户确认，不从文案、模型补丁或旧任务推断审核权限。 */
export function trafficRouteReviewAuthorized(snapshot: AgentSnapshot | undefined): boolean {
  if (!snapshot?.run) return false;
  const approval = [...snapshot.events].reverse().find(event => event.runId === snapshot.run?.id
    && event.type === "approval")?.data?.approval as AgentApproval | undefined;
  return approval?.status === "approved" && approval.trafficRouteReviewAuthorized === true
    && approval.intentVersion === snapshot.run.intentVersion
    && approval.scope.includes("vbk.write_phase:trafficLine");
}
