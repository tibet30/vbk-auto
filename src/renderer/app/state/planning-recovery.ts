import {
  PLANNING_STAGES,
  type PlanningGenerationState,
  type PlanningStage,
} from "../../../shared/contracts-planning.js";
import {
  buildPlanningStageProgress,
  planningStageLabel,
  type PlanningStageProgress,
} from "../helpers/constants.js";

export interface PlanningRecoveryView {
  status: PlanningGenerationState["status"];
  headline: string;
  completed: PlanningStage[];
  accepted: string[];
  missing: string[];
  currentStage: PlanningStage;
  currentStageLabel: string;
  stageProgress: PlanningStageProgress[] | null;
  allStagesCompleted: boolean;
  hint: string;
}

export function buildPlanningRecovery(
  planningState: PlanningGenerationState | null | undefined,
): PlanningRecoveryView | null {
  if (!planningState) return null;
  const stages = planningState.stages ?? [];
  const accepted: string[] = [];
  const missing: string[] = [];
  for (const entry of stages) {
    for (const m of entry.accepted ?? []) {
      if (!accepted.includes(m.module)) accepted.push(m.module);
    }
    for (const m of entry.rejected ?? []) {
      if (m.status === "missing" && !missing.includes(m.module)) missing.push(m.module);
    }
  }
  const completed = planningState.completedStages ?? [];
  const status = planningState.status;
  const allStagesCompleted = PLANNING_STAGES.every((stage) => completed.includes(stage));
  if (status === "completed" && allStagesCompleted) return null;
  let headline = "方案规划未完成。";
  if (status === "running") headline = "方案规划进行中…";
  else if (status === "pending") headline = "方案规划即将开始…";
  else if (status === "failed") headline = "方案规划失败，需要重试。";
  else if (status === "needs_user") headline = "方案规划已暂停，等待补充缺失模块。";
  else if (status === "completed") headline = "方案已生成部分结果，等待继续规划。";
  const stageProgress = status === "running" || status === "pending" || (status === "completed" && !allStagesCompleted)
    ? buildPlanningStageProgress(planningState, PLANNING_STAGES)
    : null;
  return {
    status,
    headline,
    completed,
    accepted,
    missing,
    currentStage: planningState.currentStage,
    currentStageLabel: planningStageLabel(planningState.currentStage),
    stageProgress,
    allStagesCompleted,
    hint: status === "needs_user"
      ? "已自动跳过已接受模块；点击「继续规划」补齐缺失项。"
      : status === "failed"
        ? "请检查 API Key 后点击「重试规划」。"
        : status === "pending"
          ? "系统正在准备下一阶段，完成后会自动跳回产品面板。"
          : status === "completed"
            ? "已保留当前已生成内容；后端状态已结束，需继续规划后才会补齐剩余阶段。"
            : "系统正在分阶段生成方案，完成后会自动跳回产品面板。",
  };
}
