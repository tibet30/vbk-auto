import assert from "node:assert/strict";
import test from "node:test";
import { buildProductSnapshot } from "../../src/main/infrastructure/database/parts/product-draft.js";
import { automationStartPhase, approvedWorkflowPlan } from "../../src/main/automation/automation.main/runtime/workflow-plan.js";
import { draftPhasesFor } from "../../src/main/automation/automation.main/automation.main.phases.js";
import { parseProduct } from "../../src/main/automation/schema/schema.js";
import { preparePhaseRetry, prepareQueuedPhaseResume, prepareSinglePhaseRetry } from "../../src/main/automation/phase-retry.js";
import { failedAutomationResumePhase } from "../../src/main/automation/automation.main/automation.main.resume-phase.js";
import { settleRunAfterVerifiedPreflight } from "../../src/main/automation/automation.main/automation.main.run-one-state.js";

function product(status: "failed" | "queued" | "succeeded" | "cancelled" = "failed") {
  const value = buildProductSnapshot({ destination: "成都", days: 1, productForm: "groupTour" });
  value.productId = "parent";
  Object.assign(value.product.basicInfo!, { subtitle: "成都游览", province: "四川", operationNotes: "按行程安排" });
  Object.assign(value.product.operations!, { pickupCity: "成都" });
  value.product.itinerary = [{ day: 1, title: "成都", spots: [], description: "游览", hotel: "", meals: "自理" }];
  const phases = draftPhasesFor(parseProduct(value.product));
  value.automation = { id: "run", status, currentPhase: "presentation", logs: [],
    phases: phases.map(phase => ({ phase, status: phase === "basic" ? "completed" : phase === "presentation" ? "failed" : "pending" })) };
  return value;
}

test("normal start and approved continuation both resume the durable failure", () => {
  for (const status of ["failed", "cancelled"] as const) {
    const value = product(status);
    assert.equal(automationStartPhase(value), "presentation");
    assert.deepEqual(approvedWorkflowPlan(value), { kind: "run", retryFrom: "presentation" });
    assert.deepEqual(approvedWorkflowPlan(value, "run"), { kind: "run" });
  }
});

test("queued approved recovery preserves the completed prefix; a new shell has no middle-stage retry", () => {
  const value = product("queued");
  value.automation!.phases[1].status = "pending";
  assert.deepEqual(approvedWorkflowPlan(value), { kind: "run", retryFrom: "presentation" });
  value.productId = undefined;
  assert.deepEqual(approvedWorkflowPlan(value), { kind: "run", retryFrom: undefined });
  assert.equal(automationStartPhase(value), undefined);
});

test("unknown cancelled or failed checkpoints refuse a full restart", () => {
  for (const status of ["failed", "cancelled"] as const) {
    const value = product(status);
    value.automation!.phases.forEach(row => { row.status = "pending"; });
    assert.throws(() => approvedWorkflowPlan(value), /安全恢复/);
    assert.throws(() => automationStartPhase(value), /安全恢复/);
  }
});

test("pre-write guard rejection can restart even after the shared failure transition adds recovery evidence", () => {
  const value = product();
  value.productId = undefined;
  value.automation!.currentPhase = "saleControl";
  value.automation!.phases.forEach(row => { row.status = "pending"; });
  value.automation!.logs.push({ at: "now", level: "error", message: "当前任务未处于可录入状态。" });
  value.automation!.recovery = { phases: { saleControl: { phase: "saleControl", state: "needs_user", attempts: [], finalError: "当前任务未处于可录入状态。" } } };
  assert.equal(automationStartPhase(value), undefined);
  assert.deepEqual(approvedWorkflowPlan(value), { kind: "run" });
  value.automation!.logs = [];
  assert.deepEqual(approvedWorkflowPlan(value), { kind: "run", retryFrom: "saleControl" });
});

test("a cancelled shell with a durable ID enters read-only recovery instead of recreation", () => {
  const value = product("cancelled");
  value.automation!.currentPhase = "saleControl";
  value.automation!.phases.forEach(row => { row.status = "pending"; });
  assert.deepEqual(approvedWorkflowPlan(value), { kind: "run", retryFrom: "saleControl" });
});

test("parent failure takes precedence over unresolved optional traffic diagnostics", () => {
  const value = product();
  value.automation!.currentPhase = "preflight";
  value.automation!.phases.forEach(row => { row.status = row.phase === "preflight" ? "failed" : "completed"; });
  value.automation!.phases.push({ phase: "trafficLine", status: "failed" });
  value.automation!.recovery = { phases: { trafficLine: { phase: "trafficLine", state: "needs_user", attempts: [], finalError: "child pending" } } };
  assert.equal(failedAutomationResumePhase(value.automation), "preflight");
});

test("stop after verified preflight resumes only its read-only check", () => {
  const value = product("cancelled");
  value.automation!.currentPhase = "preflight";
  value.automation!.phases.forEach(row => { row.status = "completed"; });
  assert.equal(failedAutomationResumePhase(value.automation), "preflight");
  const resumed = preparePhaseRetry(value.automation!, value.automation!.phases.map(row => row.phase), "preflight");
  assert.ok(resumed.phases.slice(0, -1).every(row => row.status === "completed"));
  assert.equal(resumed.phases.at(-1)?.status, "pending");
});

test("parent preflight settlement leaves each traffic failure and final readback untouched", () => {
  const value = product();
  value.automation!.phases.push({ phase: "trafficLine", status: "failed" });
  value.automation!.trafficLine = { children: [{ variant: "flightRoundTrip", lineDescription: "飞机往返",
    childProductId: "child", completedStages: ["childCreated"], verified: false, failedStage: "finalReadback" }] };
  value.automation!.recovery = { phases: { trafficLine: { phase: "trafficLine", state: "needs_user", attempts: [], finalError: "条款回读失败" } } };
  const children = structuredClone(value.automation!.trafficLine);
  value.automation = settleRunAfterVerifiedPreflight(value.automation!);
  assert.equal(value.automation.phases.find(row => row.phase === "trafficLine")?.status, "failed");
  assert.deepEqual(value.automation.trafficLine, children);
  assert.deepEqual(approvedWorkflowPlan(value), { kind: "complete" });
  Object.assign(value.product.operations!, { trafficLine: { enabled: true, variants: ["flightRoundTrip"] } });
  assert.deepEqual(approvedWorkflowPlan(value), { kind: "traffic-backfill" });
});

test("optional traffic failure does not prevent queued parent preflight from resuming", () => {
  const value = product("queued");
  const run = value.automation!;
  run.phases = [{ phase: "basic", status: "completed" }, { phase: "trafficLine", status: "failed" }, { phase: "preflight", status: "pending" }];
  const next = prepareQueuedPhaseResume(run, ["basic", "trafficLine", "preflight"], "preflight");
  assert.deepEqual(next.phases.map(row => row.status), ["completed", "failed", "pending"]);
});

test("single-phase repair retains diagnosis history without mutating the previous snapshot", () => {
  const value = product();
  const run = value.automation!;
  run.recovery = { phases: { presentation: { phase: "presentation", state: "needs_user",
    attempts: [{ attempt: 1, at: "now", error: "upload failed", diagnosis: { summary: "failed", rootCause: "rejected", expectedEvidence: "readback" } }] } } };
  const before = structuredClone(run);
  const next = prepareSinglePhaseRetry(run, run.phases.map(row => row.phase), "presentation");
  assert.equal(next.recovery!.phases.presentation.attemptsHistory?.[0].diagnosis?.rootCause, "rejected");
  next.recovery!.phases.presentation.attemptsHistory![0].error = "modified";
  assert.deepEqual(run, before);
});
