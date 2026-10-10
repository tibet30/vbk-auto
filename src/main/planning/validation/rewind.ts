/**
 * rewind 工具：
 *   - MODULE_TO_STAGE：模块 → 负责生成它的阶段；
 *   - earliestInvalidStage：给定一组 invalid 模块，找出 PLANNING_STAGES 中
 *     最早出现的负责阶段；
 *   - rewindForInvalid：重新计算 state，根据 invalid 模块把 earliestStage 及
 *     之后的阶段从 completedStages 中移除，并设置 currentStage = earliestStage、
 *     status = "needs_user"。保留更早的、已经合法的 completedStages。
 *
 *   lastAssistantReply / lastModuleSummary 不被清理，UI 仍可读「上一轮跑过哪些」。
 */

import type { ModuleOutcome, PlanningGenerationState, PlanningModule, PlanningStage } from "../../../shared/contracts-planning.js";

export const MODULE_TO_STAGE: Readonly<Record<PlanningModule, PlanningStage>> = {
  basicInfo: "basicInfo",
  skeleton: "skeleton",
  itinerary: "itinerary",
  presentation: "presentation",
  packageName: "commercial",
  pricing: "commercial",
  inventory: "commercial",
  terms: "commercial",
  release: "commercial",
  researchTasks: "research",
};

/**
 * 给定一组 invalid 模块，找出 PLANNING_STAGES 中最早出现的负责阶段。
 * 返回 undefined 表示「没有需要 rewound 的阶段」（即 invalid 全部来自
 * 一个不属于任一阶段的模块——理论上不会发生）。
 */
export function earliestInvalidStage(
  invalid: ReadonlyArray<ModuleOutcome>,
  stageOrder: ReadonlyArray<PlanningStage>,
): PlanningStage | undefined {
  const stages = new Set<PlanningStage>();
  for (const m of invalid) {
    const stage = MODULE_TO_STAGE[m.module];
    if (stage) stages.add(stage);
  }
  return stageOrder.find((s) => stages.has(s));
}

/**
 * 重新计算一个 state：根据 invalid 模块把 earliestStage 及之后的阶段
 * 从 completedStages 中移除，并设置 currentStage = earliestStage、status
 * = "needs_user"。保留更早的、已经合法的 completedStages。
 *
 *  返回的对象是新的，不会原地修改 state。
 */
export function rewindForInvalid(args: {
  state: PlanningGenerationState;
  invalid: ReadonlyArray<ModuleOutcome>;
  stageOrder: ReadonlyArray<PlanningStage>;
}): PlanningGenerationState {
  const earliest = earliestInvalidStage(args.invalid, args.stageOrder);
  if (!earliest) return args.state;
  const earliestIdx = args.stageOrder.indexOf(earliest);
  if (earliestIdx < 0) return args.state;
  const validStages = args.state.completedStages.filter((s) => args.stageOrder.indexOf(s) < earliestIdx);
  const reasons = args.invalid.map((m) => m.module);
  const lastMissing = args.state.lastMissingSummary ?? [];
  return {
    ...args.state,
    status: "needs_user",
    currentStage: earliest,
    completedStages: validStages,
    lastMissingSummary: [...new Set([...lastMissing, ...reasons])],
  };
}