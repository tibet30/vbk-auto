/**
 * PlanningPlanV2：单次 planning run 的实时快照，包含节点 / POI / 用户意图 /
 * itinerary adoption 状态；持久化为 local_product 单行，由 orchestrator
 * 推进 currentNode。
 */

import type { PlanningNodeId, PlanningNodeState, ItineraryAdoptionState } from "./stages.js";
import type { PlanningPoiCandidate } from "./poi.js";
import type { PlanningUserIntent } from "../contracts-planning-intent.js";

export interface PlanningPlanV2 {
  version: 2;
  runId: string;
  status: "pending" | "running" | "needs_user" | "completed" | "failed";
  currentNode: PlanningNodeId;
  nodes: PlanningNodeState[];
  poiCandidates: PlanningPoiCandidate[];
  userIntent?: PlanningUserIntent;
  createdAt: string;
  updatedAt: string;
  itineraryAdoption?: ItineraryAdoptionState;
}