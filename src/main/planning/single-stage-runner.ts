/**
 * 单阶段执行器 barrel：推进 planner / runtime 输入到下一阶段。
 *
 * 子模块分工：
 *   - types.ts          对外契约 SingleStageResult / RunSingleStageArgs；
 *   - result.ts        makeStageResult + now() + normaliseStageOutcomes；
 *   - skeleton-validation-research.ts   runSkeletonStage / runValidationStage / runResearchStage；
 *   - ai-stage.ts      runAiStage：AI 阶段的通用重试循环（最重的一块）；
 *   - dispatcher.ts    runSingleStage：按 stage 派发到上面 4 个子函数。
 *
 * 调用方继续 `import { runSingleStage } from "./single-stage-runner.js"`，符号
 * 由下面这些行再聚合出去。
 */

export type { SingleStageResult, RunSingleStageArgs } from "./single-stage-runner/types.js";

export { runSingleStage } from "./single-stage-runner/dispatcher.js";