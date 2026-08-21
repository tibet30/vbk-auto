import assert from "node:assert/strict";
import test from "node:test";
import { createPlanningPlanV2 } from "../../src/main/planning/three-stage-orchestrator.js";
import { invalidatePlanningStage, resetProductForPlanningStage } from "../../src/main/planning/planning-v2-reset.js";

const product = {
  sales: { productForm: "privateTour" },
  basicInfo: { supplierProductCode: "KEEP", destinationCity: "拉萨", province: "西藏", days: 3, subtitle: "清除", operationNotes: "清除" },
  operations: { pickupCity: "拉萨", vehicleResource: { resourceGroupId: 8, resourceGroupName: "车组" } },
  itinerary: [{ day: 1 }],
  presentation: { recommendation: "清除" },
  commercial: { pricing: { adult: 1 } },
};

test("rerun itinerary preserves immutable skeleton and clears itinerary plus downstream", () => {
  const next = resetProductForPlanningStage(product, "itinerary");
  assert.equal((next.basicInfo as any).supplierProductCode, "KEEP");
  assert.equal((next.basicInfo as any).province, "西藏");
  assert.deepEqual(next.itinerary, []);
  assert.equal(next.presentation, undefined);
  assert.deepEqual(next.commercial, {});
  assert.deepEqual((next.operations as any).vehicleResource, {});
});

test("major-stage invalidation only resets selected stage and downstream", () => {
  const plan = createPlanningPlanV2();
  plan.nodes = plan.nodes.map((node) => ({ ...node, status: "completed", attempts: 1 }));
  const next = invalidatePlanningStage(plan, "completion");
  assert.equal(next.nodes.find((node) => node.id === "itineraryDraft")?.status, "completed");
  assert.equal(next.nodes.find((node) => node.id === "copy")?.status, "pending");
  assert.equal(next.nodes.find((node) => node.id === "copy")?.attempts, 0);
});
