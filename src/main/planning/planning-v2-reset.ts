import type { PlanningMajorStage, PlanningPlanV2 } from "../../shared/contracts-planning.js";
import { createPlanningPlanV2 } from "./three-stage-orchestrator.js";

export function resetProductForPlanningStage(
  product: Record<string, unknown>,
  stage: PlanningMajorStage,
): Record<string, unknown> {
  const next = structuredClone(product);
  const basic = asRecord(next.basicInfo) ?? {};
  const operations = asRecord(next.operations) ?? {};

  if (stage === "foundation") {
    basic.subtitle = "";
    basic.operationNotes = "";
    next.itinerary = [];
    delete next.presentation;
    next.commercial = {};
    operations.vehicleResource = {};
    delete operations.hotelResource;
    operations.pickupCity = "";
    delete operations.transport;
  } else if (stage === "itinerary") {
    basic.subtitle = "";
    basic.operationNotes = "";
    next.itinerary = [];
    delete next.presentation;
    next.commercial = {};
    operations.vehicleResource = {};
    delete operations.hotelResource;
  } else {
    basic.subtitle = "";
    basic.operationNotes = "";
    delete next.presentation;
    next.commercial = {};
    operations.vehicleResource = {};
  }

  next.basicInfo = basic;
  next.operations = operations;
  return next;
}

export function invalidatePlanningStage(
  existing: PlanningPlanV2 | undefined,
  stage: PlanningMajorStage,
): PlanningPlanV2 {
  const base = existing?.version === 2 ? structuredClone(existing) : createPlanningPlanV2();
  const rank: Record<PlanningMajorStage, number> = { foundation: 0, itinerary: 1, completion: 2 };
  const now = new Date().toISOString();
  const nodes = base.nodes.map((node) => rank[node.majorStage] >= rank[stage]
    ? { id: node.id, majorStage: node.majorStage, status: "pending" as const, attempts: 0 }
    : node);
  const currentNode = nodes.find((node) => node.status === "pending")?.id ?? "skeleton";
  return {
    ...base,
    status: "pending",
    currentNode,
    nodes,
    poiCandidates: rank[stage] <= rank.itinerary ? [] : base.poiCandidates,
    updatedAt: now,
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
