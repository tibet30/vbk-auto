/**
 * three-stage-orchestrator 的对外类型与 NODE_DEFINITIONS：
 *   - ThreeStageOrchestratorDependencies：runThreeStagePlan 入口依赖；
 *   - NODE_DEFINITIONS：(PlanningNodeId, PlanningMajorStage) 对应表，按顺序生成空 plan。
 *
 * 历史 importer 继续 `import type { ThreeStageOrchestratorDependencies } from
 * "./three-stage-orchestrator.js"`，符号由 barrel 聚合出去。
 */

import type { Planner, PlanningMajorStage, PlanningNodeId, PlanningSkeleton, ThreeStagePlanningAi } from "../../../shared/contracts-planning.js";
import type { PoiSuggestDetailResult } from "../../../shared/contracts-types.js";
import type { OrchestratorRuntime } from "../types.js";
import type { PlanningPlanV2 } from "../../../shared/contracts-planning.js";
import type { resolveItineraryHotelCandidates } from "../../infrastructure/ctrip-hotel-search.js";

export interface ThreeStageOrchestratorDependencies {
  localProductId: string;
  skeleton: PlanningSkeleton & { province: string; city: string };
  planner: Planner;
  ai: ThreeStagePlanningAi;
  runtime: OrchestratorRuntime;
  initialPlan?: PlanningPlanV2;
  persist(plan: PlanningPlanV2): Promise<void>;
  assertVbkLogin(): Promise<void>;
  queryPoi(name: string): Promise<PoiSuggestDetailResult>;
  resolveHotels(itinerary: Array<Record<string, unknown>>, nights?: number): Promise<Awaited<ReturnType<typeof resolveItineraryHotelCandidates>>>;
  resolveCover(): Promise<{ complete: boolean; summary: string }>;
  resolveVehicle(): Promise<{ complete: boolean; summary: string }>;
  privateTour: boolean;
  providerLabel?: string;
}

export const NODE_DEFINITIONS: Array<[PlanningNodeId, PlanningMajorStage]> = [
  ["skeleton", "foundation"],
  ["spotCandidates", "itinerary"],
  ["poiResolution", "itinerary"],
  ["itineraryDraft", "itinerary"],
  ["hotelResolution", "itinerary"],
  ["copy", "completion"],
  ["presentation", "completion"],
  ["commercial", "completion"],
  ["cover", "completion"],
  ["vehicleResource", "completion"],
  ["finalValidation", "completion"],
];