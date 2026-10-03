import assert from "node:assert/strict";
import test from "node:test";
import { runDraftPhaseWithRecovery } from "../../src/main/automation/automation.main/optional-traffic-phase.ts";
import { resolveRunStatusAfterSinglePhaseSuccess } from "../../src/main/automation/automation.main/automation.main.run-one-state.ts";
import { preparePhaseRetry } from "../../src/main/automation/phase-retry.ts";
import type { AutomationRun } from "../../src/shared/contracts.ts";
import type { RecoveryContext } from "../../src/main/automation/recovery/recovery.ts";

function run(): AutomationRun {
  return { id: "luzhou", status: "running", logs: [], phases: [
    { phase: "basic", status: "completed" },
    { phase: "trafficLine", status: "pending" },
    { phase: "preflight", status: "pending" },
  ], trafficLine: { children: [{ variant: "flightRoundTrip", lineDescription: "飞机往返",
    childProductId: "79242913", verified: false, completedStages: ["childCreated"] }] } };
}
function context(automation: AutomationRun, phase = "trafficLine"): RecoveryContext {
  return { run: automation, phase, completedPhases: ["basic"], productIdExists: true,
    basicInfoSaved: true, execute: async () => { throw new Error("VBK 行程详情保存浏览器请求超时（15000ms）"); },
    advisor: async () => ({ action: "wait_for_user", summary: "未完成", rootCause: "超时",
      expectedEvidence: "回读", userInstruction: "单独修复大交通" }),
    applyAction: async () => undefined, persist: () => undefined, log: () => undefined };
}

test("Luzhou traffic timeout retains failure and allows parent preflight to finish", async () => {
  const automation = run();
  assert.equal((await runDraftPhaseWithRecovery(context(automation))).status, "needs_user");
  assert.equal(automation.phases[1].status, "failed");
  assert.match(automation.trafficLine!.failureReason!, /15000ms/);
  assert.equal(automation.trafficLine!.children[0].childProductId, "79242913");
  assert.equal(automation.trafficLine!.children[0].verified, false);
  assert.equal(automation.trafficLine!.verifiedAt, undefined);
  const preflight = context(automation, "preflight");
  preflight.execute = async () => undefined;
  assert.equal((await runDraftPhaseWithRecovery(preflight)).status, "completed");
  assert.equal(resolveRunStatusAfterSinglePhaseSuccess(automation, "failed"), "succeeded");
});

test("failed parent preflight remains blocking even when traffic is optional", async () => {
  const automation = run();
  await runDraftPhaseWithRecovery(context(automation));
  await runDraftPhaseWithRecovery(context(automation, "preflight"));
  assert.equal(resolveRunStatusAfterSinglePhaseSuccess(automation, "failed"), "failed");
});

test("cancelled traffic never starts the next parent phase", async () => {
  const automation = run();
  const ctx = context(automation); ctx.shouldCancel = () => true;
  assert.equal((await runDraftPhaseWithRecovery(ctx)).status, "cancelled");
  assert.equal(automation.phases[2].status, "pending");
});

test("traffic retry failure preserves verified parent and pending preflight stays queued", async () => {
  const automation = run(); automation.phases[2].status = "completed";
  await runDraftPhaseWithRecovery(context(automation));
  assert.equal(resolveRunStatusAfterSinglePhaseSuccess(automation, "succeeded"), "succeeded");
  automation.phases[2].status = "pending";
  assert.equal(resolveRunStatusAfterSinglePhaseSuccess(automation, "failed"), "queued");
});

test("historical failed traffic resumes pending parent preflight without replaying traffic", () => {
  const automation = run(); automation.status = "failed"; automation.phases[1].status = "failed";
  const next = preparePhaseRetry(automation, ["basic", "trafficLine", "preflight"], "preflight");
  assert.deepEqual(next.phases.map((phase) => phase.status), ["completed", "failed", "pending"]);
  assert.throws(() => preparePhaseRetry({ ...automation, phases: [
    { phase: "basic", status: "pending" }, ...automation.phases.slice(1),
  ] }, ["basic", "trafficLine", "preflight"], "preflight"), /不是失败状态/);
});

test("partial traffic handler return retains failure rather than claiming child success", async () => {
  const automation = run(); const ctx = context(automation);
  ctx.execute = async () => { automation.trafficLine!.failureReason = "子产品资源保存未完成"; };
  assert.equal((await runDraftPhaseWithRecovery(ctx)).status, "needs_user");
  assert.equal(automation.phases[1].status, "failed");
  assert.equal(automation.trafficLine!.children[0].verified, false);
});
