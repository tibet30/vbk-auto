/**
 * 规划状态 rewind 帮手：负责「已完成状态反查 + 失效时回退到负责阶段」。
 *
 *  把这块逻辑从 plan-orchestrator.ts 抽出，避免主文件超过 350 行 size budget。
 *  行为契约：
 *    - 状态为 completed 时必须调用 revalidateCompletedState，把产品重新跑
 *      deepValidateModules；如果 invalid 则 rewind 到 earliest invalid stage，
 *      重置 status=needs_user；
 *    - 对单个 invalid 模块集合，rewindForInvalid 必须按 PLANNING_STAGES 顺序
 *      找出最早负责阶段，保留之前的 completedStages 不动；
 *    - 当前阶段已经在运行 / 还在写持久化的状态下不应该调用本文件的 API；
 *      调用方必须保证 read-only 视角（先 save 后 rewind）。
 */

import type {
  ModuleOutcome,
  PlanningGenerationState,
  PlanningSkeleton,
} from "../../shared/contracts-planning.js";
import { PLANNING_STAGES } from "../../shared/contracts-planning.js";
import { deepValidateModules } from "./validation.js";
import { rewindForInvalid } from "./validation.js";
import type { OrchestratorRuntime } from "./types.js";

export interface RevalidateArgs {
  state: PlanningGenerationState;
  skeleton: PlanningSkeleton;
  runtime: OrchestratorRuntime;
}

/**
 * 重新校验 state 是否仍可声明 completed：跑 deepValidateModules，
 * 发现任何 invalid 模块就 rewind 到 earliest invalid stage，状态置 needs_user。
 * 返回新的 state（即便不需要 rewind，也是新对象以便调用方无脑保存）。
 */
export async function revalidateCompletedState(args: RevalidateArgs): Promise<PlanningGenerationState> {
  const product = await args.runtime.loadCurrentProduct(args.state.projectId);
  const accepted = await args.runtime.loadAcceptedModules(args.state.projectId);
  const deep = deepValidateModules({
    skeleton: args.skeleton,
    product,
    acceptedModules: accepted,
  });
  if (!deep.invalid.length) return args.state;
  return rewindForInvalid({
    state: args.state,
    invalid: deep.invalid,
    stageOrder: PLANNING_STAGES,
  });
}

/**
 * 给一组 invalid 模块做 rewind 并叠加 missing 摘要。纯粹的 pure helper，
 * 供 validation stage 阶段在返回 needs_user 之前同步更新状态。
 */
export function buildRewoundState(args: {
  state: PlanningGenerationState;
  invalid: ModuleOutcome[];
}): PlanningGenerationState {
  return rewindForInvalid({
    state: args.state,
    invalid: args.invalid,
    stageOrder: PLANNING_STAGES,
  });
}