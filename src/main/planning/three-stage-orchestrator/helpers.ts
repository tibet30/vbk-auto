/**
 * three-stage-orchestrator/helpers：纯函数 + 节点 patch 工具：
 *   - node / isCompleted：节点状态读写 / 判定；
 *   - errorMessage / text / asRecord：值类型 helper；
 *   - hasStandardLocation / isValidDestinationCity / stageSummary：阶段级判定；
 *   - terminal / failPlan：节点失败收尾（patchNode + 标记 plan.status = needs_user）。
 */

import type { PlanningNodeId, PlanningNodeState, PlanningPlanV2 } from "../../../shared/contracts-planning.js";
import { isAcceptablePlanningRegionName, isProvinceLevelName, normaliseProvinceName } from "../runtime.js";

export function node(plan: PlanningPlanV2, id: PlanningNodeId): PlanningNodeState {
  return plan.nodes.find((entry) => entry.id === id)!;
}

export function isCompleted(plan: PlanningPlanV2, id: PlanningNodeId): boolean {
  const status = node(plan, id).status;
  return status === "completed" || status === "skipped";
}

export function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 300);
}

export function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function hasStandardLocation(province: string, city: string): boolean {
  return Boolean(province && isAcceptablePlanningRegionName(province, city) && isValidDestinationCity(city, normaliseProvinceName(province)));
}

export function isValidDestinationCity(city: string, province: string): boolean {
  const value = city.trim();
  if (!value || value.length > 40 || /\d/.test(value)) return false;
  if (!isProvinceLevelName(value)) return true;
  return ["北京", "天津", "上海", "重庆", "香港", "澳门"].includes(normaliseProvinceName(province))
    && normaliseProvinceName(value) === normaliseProvinceName(province);
}

export function stageSummary(stage: string): string {
  if (stage === "basicInfo") return "副标题与 Operation Notes 已生成";
  if (stage === "presentation") return "推荐语、3 条推荐理由、分类与卖点已生成";
  return "套餐名、价格、库存与草稿 Release 已生成";
}

export async function terminal(
  plan: PlanningPlanV2,
  patchNode: (id: PlanningNodeId, patch: Partial<PlanningNodeState>) => Promise<void>,
  id: PlanningNodeId,
  error: string,
): Promise<PlanningPlanV2> {
  await patchNode(id, { status: "failed", error });
  return { ...plan, status: "needs_user", currentNode: id };
}

export async function failPlan(
  plan: PlanningPlanV2,
  patchNode: (id: PlanningNodeId, patch: Partial<PlanningNodeState>) => Promise<void>,
  id: PlanningNodeId,
  error: string,
): Promise<PlanningPlanV2> {
  await patchNode(id, { status: "failed", error });
  return { ...plan, status: "needs_user", currentNode: id };
}