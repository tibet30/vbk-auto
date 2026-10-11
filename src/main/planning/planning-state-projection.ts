import {
  PLANNING_STAGES,
  type PlanningGenerationState,
  type PlanningNodeId,
  type PlanningNodeState,
  type PlanningPlanV2,
  type PlanningStage,
  type StagePersistedState,
} from "../../shared/contracts-planning.js";

const NODE_TO_STAGE: Readonly<Record<PlanningNodeId, PlanningStage>> = {
  skeleton: "skeleton",
  spotCandidates: "itinerary",
  poiResolution: "itinerary",
  itineraryDraft: "itinerary",
  hotelResolution: "itinerary",
  copy: "basicInfo",
  presentation: "presentation",
  commercial: "commercial",
  cover: "research",
  vehicleResource: "research",
  finalValidation: "validation",
};

const REQUIRED_NODES: readonly PlanningNodeId[] = [
  "skeleton",
  "spotCandidates",
  "poiResolution",
  "itineraryDraft",
  "hotelResolution",
  "copy",
  "presentation",
  "commercial",
  "cover",
  "vehicleResource",
  "finalValidation",
];

const NODE_DONE = new Set<PlanningNodeState["status"]>(["completed", "skipped"]);

function nodesFor(plan: PlanningPlanV2, id: PlanningNodeId): PlanningNodeState[] {
  return plan.nodes.filter((node) => node.id === id);
}

function isNodeDone(plan: PlanningPlanV2, id: PlanningNodeId): boolean {
  const entries = nodesFor(plan, id);
  // An absent node (or a duplicate with one unfinished copy) is deliberately
  // incomplete. This keeps old, truncated snapshots from claiming completion.
  return entries.length > 0 && entries.every((node) => NODE_DONE.has(node.status));
}

function latestTimestamp(nodes: PlanningNodeState[], fallback: string): string {
  const timestamps = nodes.flatMap((node) => [node.startedAt, node.completedAt])
    .filter((value): value is string => Boolean(value));
  if (timestamps.length === 0) return fallback;
  return timestamps.reduce((latest, value) => {
    const latestTime = Date.parse(latest);
    const valueTime = Date.parse(value);
    if (Number.isNaN(latestTime) || Number.isNaN(valueTime)) return value > latest ? value : latest;
    return valueTime >= latestTime ? value : latest;
  });
}

function stageNodes(plan: PlanningPlanV2, stage: PlanningStage): PlanningNodeState[] {
  return REQUIRED_NODES
    .filter((id) => NODE_TO_STAGE[id] === stage)
    .flatMap((id) => nodesFor(plan, id));
}

function stageState(plan: PlanningPlanV2, stage: PlanningStage): StagePersistedState {
  const nodes = stageNodes(plan, stage);
  const failed = [...nodes].reverse().find((node) => node.status === "failed" || node.status === "blocked");
  const attempts = nodes.reduce((max, node) => Math.max(max, node.attempts), 0);
  return {
    stage,
    // A planning node proves execution progress only. It does not prove that
    // any business module was accepted, so module lists stay empty here.
    accepted: [],
    rejected: [],
    attempts,
    ...(failed ? {
      lastError: {
        stage,
        attempt: Math.max(1, failed.attempts),
        code: failed.status,
        message: failed.error || `${failed.id} 节点未完成。`,
      },
    } : {}),
    updatedAt: latestTimestamp(nodes, plan.updatedAt),
  };
}

function projectedStatus(plan: PlanningPlanV2, allNodesDone: boolean): PlanningGenerationState["status"] {
  if (plan.status !== "completed" || allNodesDone) return plan.status;
  // A stale completed marker is not a successful legacy run. Keep it
  // resumable so missing, pending, failed, or invalidated nodes remain visible.
  return "needs_user";
}

export function toLegacyState(localProductId: string, plan: PlanningPlanV2): PlanningGenerationState {
  const completedStages = PLANNING_STAGES.filter((stage) => {
    const ids = REQUIRED_NODES.filter((id) => NODE_TO_STAGE[id] === stage);
    return ids.length > 0 && ids.every((id) => isNodeDone(plan, id));
  });
  const allNodesDone = REQUIRED_NODES.every((id) => isNodeDone(plan, id));
  const currentStage = plan.status === "completed" && !allNodesDone
    ? PLANNING_STAGES.find((stage) => !completedStages.includes(stage)) ?? "skeleton"
    : NODE_TO_STAGE[plan.currentNode] ?? "skeleton";
  return {
    localProductId,
    currentStage,
    completedStages,
    stages: PLANNING_STAGES.map((stage) => stageState(plan, stage)),
    status: projectedStatus(plan, allNodesDone),
    resumeAt: plan.updatedAt,
  };
}
