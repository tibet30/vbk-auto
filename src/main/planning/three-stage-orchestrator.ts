/**
 * three-stage-orchestrator barrel：三阶段规划编排（foundation / itinerary / completion）。
 *
 * 历史 importer 继续：
 *   import { runFoundationLocation } from "./three-stage-itinerary-flow.js";
 *   import { runThreeStagePlan, createPlanningPlanV2, ThreeStageOrchestratorDependencies } from "./three-stage-orchestrator.js";
 *
 * 子模块：
 *   - types.ts            依赖接口 + NODE_DEFINITIONS；
 *   - plan-factory.ts     createPlanningPlanV2 / normalisePlan；
 *   - helpers.ts          纯函数 + 节点 patch（failPlan / terminal 等）；
 *   - nodes.ts            runCompletionAiNode / runResourceNode / runLegacyStage；
 *   - orchestrator.ts     runThreeStagePlan 主流程。
 */

export { runFoundationLocation } from "./three-stage-itinerary-flow.js";
export type { ThreeStageOrchestratorDependencies } from "./three-stage-orchestrator/types.js";
export { createPlanningPlanV2 } from "./three-stage-orchestrator/plan-factory.js";
export { runThreeStagePlan } from "./three-stage-orchestrator/orchestrator.js";