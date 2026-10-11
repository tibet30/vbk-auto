import assert from "node:assert/strict";
import test from "node:test";
import type { PlanningPlanV2 } from "../../src/shared/contracts-planning.js";
import { toLegacyState } from "../../src/main/planning/planning-state-projection.js";

const NODE_IDS = [
  "skeleton", "spotCandidates", "poiResolution", "itineraryDraft", "hotelResolution",
  "copy", "presentation", "commercial", "cover", "vehicleResource", "finalValidation",
] as const;

function plan(status: PlanningPlanV2["status"], nodeStatus: PlanningPlanV2["nodes"][number]["status"] = "completed"): PlanningPlanV2 {
  return {
    version: 2,
    runId: "run-1",
    status,
    currentNode: "finalValidation",
    nodes: NODE_IDS.map((id, index) => ({
      id,
      majorStage: index === 0 ? "foundation" : index < 5 ? "itinerary" : "completion",
      status: nodeStatus,
      attempts: 1,
      startedAt: `2026-10-11T00:0${index}:00.000Z`,
      completedAt: nodeStatus === "completed" ? `2026-10-11T00:1${index}:00.000Z` : undefined,
    })),
    poiCandidates: [],
    createdAt: "2026-10-11T00:00:00.000Z",
    updatedAt: "2026-10-11T01:00:00.000Z",
  };
}

test("partial itinerary nodes do not complete itinerary or overall state", () => {
  const current = plan("running");
  current.nodes.find((node) => node.id === "poiResolution")!.status = "pending";
  const state = toLegacyState("product-1", current);
  assert.deepEqual(state.completedStages, ["skeleton", "basicInfo", "presentation", "commercial", "research", "validation"]);
  assert.equal(state.status, "running");
  assert.equal(state.stages.length, 7);
  assert.deepEqual(state.stages.find((stage) => stage.stage === "itinerary")!.accepted, []);
});

test("failed and invalidated nodes block completion, while skipped nodes count as done", () => {
  const current = plan("completed");
  current.nodes.find((node) => node.id === "hotelResolution")!.status = "skipped";
  current.nodes.find((node) => node.id === "cover")!.status = "failed";
  current.nodes.find((node) => node.id === "vehicleResource")!.status = "invalidated";
  const state = toLegacyState("product-1", current);
  assert.ok(state.completedStages.includes("itinerary"));
  assert.ok(!state.completedStages.includes("research"));
  assert.equal(state.status, "needs_user");
  assert.equal(state.stages.find((stage) => stage.stage === "research")!.lastError?.message, "cover 节点未完成。");
});

test("historical missing nodes remain incomplete and stale completed cannot false-success", () => {
  const current = plan("completed");
  current.nodes = current.nodes.filter((node) => node.id !== "vehicleResource" && node.id !== "finalValidation");
  const state = toLegacyState("product-1", current);
  assert.equal(state.status, "needs_user");
  assert.equal(state.currentStage, "research");
  assert.ok(!state.completedStages.includes("research"));
  assert.ok(!state.completedStages.includes("validation"));
  assert.equal(state.resumeAt, current.updatedAt);
});

test("stale completed snapshots point to the earliest incomplete legacy stage", () => {
  const copyPending = plan("completed");
  copyPending.nodes.find((node) => node.id === "copy")!.status = "pending";
  assert.equal(toLegacyState("product-1", copyPending).currentStage, "basicInfo");

  const itineraryPending = plan("completed");
  itineraryPending.nodes.find((node) => node.id === "itineraryDraft")!.status = "pending";
  assert.equal(toLegacyState("product-1", itineraryPending).currentStage, "itinerary");
});

test("all required nodes completed or skipped produce deterministic completed projection", () => {
  const current = plan("completed");
  current.nodes.find((node) => node.id === "vehicleResource")!.status = "skipped";
  const state = toLegacyState("product-1", current);
  assert.deepEqual(state.completedStages, ["skeleton", "basicInfo", "itinerary", "presentation", "commercial", "research", "validation"]);
  assert.equal(state.status, "completed");
  assert.deepEqual(state.stages.map((entry) => entry.stage), ["skeleton", "basicInfo", "itinerary", "presentation", "commercial", "research", "validation"]);
  assert.deepEqual(state.stages.map((entry) => entry.accepted), Array.from({ length: 7 }, () => []));
});
