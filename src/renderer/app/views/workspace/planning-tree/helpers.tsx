/**
 * 三阶段产品规划树的纯函数 helper：
 *   - resolveActivePlanningNode：当前应当高亮的节点（运行中或重做中）；
 *   - placeholderNodes：阶段尚未生成时显示的占位节点；
 *   - majorStageState：聚合子节点状态到阶段级状态；
 *   - statusIcon / stageStatusIcon / overallStatusIcon：根据状态返回图标；
 *   - stageStatusLabel / overallLabel / fallbackText：状态对应的中文文案。
 */

import {
  AlertTriangle,
  Check,
  Circle,
  LoaderCircle,
  LockKeyhole,
} from "lucide-react";
import type { PlanningMajorStage, PlanningNodeId, PlanningNodeState, PlanningPlanV2 } from "../../../../../shared/contracts-planning";
import { RERUN_FALLBACK_NODES } from "./constants.js";

/**
 * 决定当前应该高亮的节点：
 *   - 阶段运行中：plan.currentNode；
 *   - 阶段重做中（手动）：用 RERUN_FALLBACK_NODES[rerunBusy]；
 *   - 其余：null。
 */
export function resolveActivePlanningNode(
  plan: PlanningPlanV2 | undefined,
  rerunBusy: PlanningMajorStage | null,
): PlanningNodeId | null {
  if (plan?.status === "running") return plan.currentNode;
  return rerunBusy ? RERUN_FALLBACK_NODES[rerunBusy] : null;
}

/** 阶段尚未生成时显示的占位节点（避免 UI 空荡）。 */
export function placeholderNodes(stage: PlanningMajorStage): PlanningNodeState[] {
  const ids = stage === "foundation" ? ["skeleton"]
    : stage === "itinerary" ? ["spotCandidates", "poiResolution", "itineraryDraft", "hotelResolution"]
      : ["copy", "presentation", "commercial", "cover", "vehicleResource", "finalValidation"];
  return ids.map((id) => ({ id: id as PlanningNodeId, majorStage: stage, status: "pending", attempts: 0 }));
}

/** 把子节点状态聚合成阶段级状态：blocked > running > failed > completed > pending。 */
export function majorStageState(nodes: PlanningNodeState[], plan?: PlanningPlanV2) {
  if (nodes.some((node) => node.status === "blocked")) return "blocked";
  if (nodes.some((node) => node.status === "running")) return "running";
  if (nodes.some((node) => node.status === "failed")) return "failed";
  if (nodes.every((node) => node.status === "completed" || node.status === "skipped")) return "completed";
  if (plan?.status === "running" && nodes.length === 0) return "pending";
  return "pending";
}

/** 节点状态 → 图标。 */
export function statusIcon(status: PlanningNodeState["status"]) {
  if (status === "running") return <LoaderCircle size={13} aria-hidden="true" />;
  if (status === "completed") return <Check size={13} aria-hidden="true" />;
  if (status === "failed" || status === "blocked") return <AlertTriangle size={13} aria-hidden="true" />;
  if (status === "skipped") return <LockKeyhole size={13} aria-hidden="true" />;
  return <Circle size={13} aria-hidden="true" />;
}

/** 阶段聚合状态 → 图标（带 spin 类名）。 */
export function stageStatusIcon(state: ReturnType<typeof majorStageState>, spinClass: string) {
  if (state === "running") return <LoaderCircle size={12} className={spinClass} aria-hidden="true" />;
  if (state === "completed") return <Check size={12} aria-hidden="true" />;
  if (state === "failed" || state === "blocked") return <AlertTriangle size={12} aria-hidden="true" />;
  return <Circle size={12} aria-hidden="true" />;
}

/** 阶段聚合状态 → 文案。 */
export function stageStatusLabel(state: ReturnType<typeof majorStageState>) {
  return ({
    pending: "未开始",
    running: "进行中",
    completed: "已完成",
    failed: "未通过",
    blocked: "被阻塞",
    skipped: "不适用",
    invalidated: "已失效",
  } as const)[state] ?? "未开始";
}

/** plan.status → 图标（带 spin 类名）。 */
export function overallStatusIcon(status: PlanningPlanV2["status"], spinClass: string) {
  if (status === "running") return <LoaderCircle size={13} className={spinClass} aria-hidden="true" />;
  if (status === "completed") return <Check size={13} aria-hidden="true" />;
  if (status === "needs_user" || status === "failed") return <AlertTriangle size={13} aria-hidden="true" />;
  return <Circle size={13} aria-hidden="true" />;
}

/** 节点兜底文案：error > summary > 默认描述。 */
export function fallbackText(node: PlanningNodeState): string {
  return node.summary || node.error || "等待生成";
}

/** plan.status → 中文文案（含 itineraryAdoption / 重做状态）。 */
export function overallLabel(plan: PlanningPlanV2): string {
  if (plan.status === "running") return "正在生成";
  if (plan.status === "completed") return "生成完成";
  if (plan.status === "needs_user") return "需要补充信息";
  if (plan.status === "failed") return "生成失败";
  return "未开始";
}