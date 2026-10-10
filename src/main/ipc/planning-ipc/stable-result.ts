/**
 * planning-ipc.ts 的"持久化 completed → PlanningRunResult"还原工具：
 *   - buildStableCompletedResult：当 planning:resume 命中"全阶段已完成且 POI 已齐全"，
 *     跳过 runPlan 时，把持久化的 PlanningGenerationState 拼回 PlanningRunResult 形状。
 */

import type { PlanningGenerationState, PlanningRunResult } from "../../../shared/contracts.js";

export function buildStableCompletedResult(state: PlanningGenerationState): PlanningRunResult {
  const accepted = state.stages.flatMap((s) => s.accepted.map((m) => m.module));
  const rejected = state.stages.flatMap((s) =>
    s.rejected.map((m) => ({ module: m.module, reason: m.reason })),
  );
  return {
    state,
    status: "completed",
    accepted,
    rejected,
    researchTasks: [],
    assistantReply: state.lastAssistantReply ?? "",
  };
}