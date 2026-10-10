/**
 * Planning 子系统契约（provider-neutral, model-neutral）的 barrel。
 *
 * 整套规划子系统都从这里导入。Prompt / schema / validator / 重试策略 /
 * status / research 规则都不能包含 provider 或 model 字样；只有
 * adapter（src/main/planning/adapters/*）里允许出现具体的 transport 参数。
 *
 * 本文件不持有具体类型：内容按"职责"拆分到 `./contracts-planning/` 子目录：
 *   - stages.ts         阶段 / 节点 / itinerary adoption 状态；
 *   - modules.ts        模块白名单 + 模块裁决 + research 提案；
 *   - poi.ts            POI 候选 + 备选名管理；
 *   - requests.ts       阶段请求形状（spot / itinerary / location）；
 *   - plan.ts           单次 planning run 的实时快照（PlanningPlanV2）；
 *   - output.ts         阶段输出 + 阶段错误契约；
 *   - state.ts          持久化的 module / stage / generation 状态；
 *   - planner.ts        Planner 接口 + context + skeleton + 请求类型；
 *   - errors.ts         PlannerError 错误类。
 *
 * 调用方继续 `import {...} from "../contracts-planning.js"`，符号由下面这
 * 9 行再聚合出去。
 */

export type {
  PlanningStage,
  PlanningMajorStage,
  PlanningNodeId,
  PlanningNodeStatus,
  PlanningNodeState,
  ItineraryAdoptionStatus,
  ItineraryAdoptionState,
} from "./contracts-planning/stages.js";
export { PLANNING_STAGES, PLANNING_STAGE_RETRY_LIMIT } from "./contracts-planning/stages.js";

export type {
  PlanningModule,
  ModuleStatus,
  ModuleOutcome,
  ResearchTaskProposal,
} from "./contracts-planning/modules.js";
export { REQUIRED_MODULES } from "./contracts-planning/modules.js";

export type { PlanningPoiCandidate } from "./contracts-planning/poi.js";

export type {
  PlanningSpotRecommendationRequest,
  PlanningItineraryRequest,
  PlanningItineraryDayDraft,
  PlanningLocationRequest,
  PlanningLocation,
} from "./contracts-planning/requests.js";

export type { PlanningPlanV2 } from "./contracts-planning/plan.js";

export type { PlanningStageOutput, PlanningStageError } from "./contracts-planning/output.js";

export type {
  ModulePersistedState,
  StagePersistedState,
  PlanningGenerationState,
} from "./contracts-planning/state.js";

export type {
  ThreeStagePlanningAi,
  PlanningSkeleton,
  PlannerContext,
  PlannerRequest,
  Planner,
  PoiNameResolutionRequest,
} from "./contracts-planning/planner.js";

export { PlannerError } from "./contracts-planning/errors.js";

// 子目录再 export 一次 POI disambiguation / correction，保留原文件顶层
// `export type * from "./contracts-planning-poi-disambiguation.js"` 等价的形状。
export type * from "./contracts-planning-poi-disambiguation.js";
export type * from "./contracts-planning-poi-correction.js";