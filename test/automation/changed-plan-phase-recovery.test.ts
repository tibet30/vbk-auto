import assert from "node:assert/strict";
import test from "node:test";
import { buildProductSnapshot } from "../../src/main/infrastructure/database/parts/product-draft.js";
import { draftPhasesFor } from "../../src/main/automation/automation.main/automation.main.phases.js";
import { parseProduct } from "../../src/main/automation/schema/schema.js";
import { entryPhaseInput, stampCompletedEntryPhase } from "../../src/main/application/product-entry-phase-fingerprint.js";
import {
  prepareChangedPlanPhaseRecovery,
  staleCompletedEntryPhases,
} from "../../src/main/automation/automation.main/changed-plan-phase-recovery.js";
import { approvedWorkflowPlan } from "../../src/main/automation/automation.main/runtime/workflow-plan.js";
import { approvalFollowsChangedPlan } from "../../src/main/automation/automation.main/changed-plan-approval.js";
import { approvedPlanVersion } from "../../src/main/application/product-approval-projection.js";
import type { AgentApproval, AgentSnapshot, ProductDetail } from "../../src/shared/contracts.js";

function completedProduct(): ProductDetail {
  const product = buildProductSnapshot({ destination: "成都", days: 2, productForm: "groupTour" });
  product.productId = "remote-1";
  Object.assign(product.product.basicInfo!, {
    subtitle: "成都品质游",
    province: "四川",
    operationNotes: "按确认行程安排",
  });
  Object.assign(product.product.operations!, { pickupCity: "成都" });
  product.product.presentation = {
    ...product.product.presentation,
    recommendation: "城市文化与自然体验",
  };
  product.product.itinerary = [
    { day: 1, title: "成都", description: "熊猫基地", spots: [], hotel: "", meals: "自理" },
    { day: 2, title: "成都", description: "市区游览后返程", spots: [], hotel: "", meals: "自理" },
  ];
  const phases = draftPhasesFor(parseProduct(product.product));
  product.automation = { id: "completed-run", status: "succeeded", logs: [],
    phases: phases.map((phase) => ({ phase, status: "completed" })) };
  for (const phase of phases) stampCompletedEntryPhase(product.automation, product.product, phase);
  return product;
}

test("a presentation edit reopens only dependent VBK columns and final preflight", () => {
  const product = completedProduct();
  assert.deepEqual(approvedWorkflowPlan(product), { kind: "complete" });
  (product.product.presentation as Record<string, unknown>).recommendation = "新的推荐理由";
  const phases = draftPhasesFor(parseProduct(product.product));
  assert.deepEqual(staleCompletedEntryPhases(product, phases), ["presentation", "package", "preflight"]);
  assert.deepEqual(approvedWorkflowPlan(product), { kind: "run", retryFrom: "presentation" });
  const resumed = prepareChangedPlanPhaseRecovery(product, phases, "presentation");
  assert.equal(resumed.phases.find((item) => item.phase === "basic")?.status, "completed");
  assert.equal(resumed.phases.find((item) => item.phase === "itinerary")?.status, "completed");
  assert.equal(resumed.phases.find((item) => item.phase === "presentation")?.status, "pending");
  assert.equal(resumed.phases.find((item) => item.phase === "package")?.status, "pending");
  assert.equal(resumed.phases.find((item) => item.phase === "preflight")?.status, "pending");
});

test("an itinerary edit cannot be short-circuited by a succeeded historical run", () => {
  const product = completedProduct();
  (product.product.itinerary[0] as Record<string, unknown>).description = "修改后的每日行程";
  const plan = approvedWorkflowPlan(product);
  assert.equal(plan.kind, "run");
  assert.equal(plan.kind === "run" ? plan.retryFrom : undefined, "itinerary");
});

test("a changed legacy run without phase fingerprints replays parent columns conservatively", () => {
  const product = completedProduct();
  for (const phase of product.automation!.phases) delete phase.inputFingerprint;
  assert.deepEqual(approvedWorkflowPlan(product), { kind: "complete" });
  assert.deepEqual(approvedWorkflowPlan(product, undefined, false, false, true),
    { kind: "run", retryFrom: "basic" });
  const phases = draftPhasesFor(parseProduct(product.product));
  const resumed = prepareChangedPlanPhaseRecovery(product, phases, "basic");
  assert.ok(resumed.phases.every((phase) => phase.status === "pending"));
});

test("a fresh approval after an older plan fingerprint marks legacy checkpoints stale", () => {
  const product = completedProduct();
  const currentVersion = approvedPlanVersion(product);
  const approval = { id: "new", status: "approved", productVersion: currentVersion,
    accountKey: "account", intentVersion: "new-intent", scope: [], summary: "确认", createdAt: "now" } as AgentApproval;
  const snapshot = { localProductId: product.id,
    run: { id: "new-run", status: "running", intentVersion: "new-intent", createdAt: "now", updatedAt: "now" },
    events: [
      { id: "old-event", runId: "old-run", type: "approval", content: "旧确认", createdAt: "old",
        data: { approval: { ...approval, id: "old", productVersion: "old-version", status: "invalidated" } } },
      { id: "new-event", runId: "new-run", type: "approval", content: "新确认", createdAt: "now",
        data: { approval } },
    ],
  } as AgentSnapshot;
  assert.equal(approvalFollowsChangedPlan(product, snapshot, approval), true);
});

test("unknown entry phases fail closed instead of receiving a tolerant whole-product fingerprint", () => {
  assert.throws(() => entryPhaseInput(completedProduct().product, "presentaton"), /未知的 VBK 录入阶段：presentaton/);
});
