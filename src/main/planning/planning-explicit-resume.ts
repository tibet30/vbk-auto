import { PLANNING_STAGE_RETRY_LIMIT, type PlanningPlanV2 } from "../../shared/contracts-planning.js";

/**
 * 用户主动点击“从失败节点继续”时，允许重新尝试已耗尽次数的单个失败节点。
 * 已完成节点和已核验的 POI 候选保持不变；旧错误保留给下一次行程编排作为
 * 约束上下文。没有显式恢复动作时绝不调用本函数，避免后台无限重试。
 */
export function prepareExplicitPlanningResume(plan: PlanningPlanV2): PlanningPlanV2 {
  const current = plan.nodes.find((node) => node.id === plan.currentNode);
  if (!current
    || !["failed", "blocked"].includes(current.status)
    || current.attempts < PLANNING_STAGE_RETRY_LIMIT) {
    return plan;
  }

  return {
    ...plan,
    status: "pending",
    nodes: plan.nodes.map((node) => node.id === current.id
      ? {
          ...node,
          status: "pending",
          attempts: 0,
          startedAt: undefined,
          completedAt: undefined,
          summary: "用户已从耗尽的失败节点继续；保留原错误与已核验候选后重新尝试。",
        }
      : node),
  };
}
