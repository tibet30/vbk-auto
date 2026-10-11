import assert from "node:assert/strict";
import test from "node:test";
import { runPhaseWithRecovery, type RecoveryContext } from "../../src/main/automation/recovery/recovery.js";

function context(): RecoveryContext {
  return { run: { id: "run", status: "running", phases: [{ phase: "itinerary", status: "running" }], logs: [] },
    phase: "itinerary", completedPhases: [], productIdExists: true, basicInfoSaved: true,
    execute: async () => { throw new Error("save failed"); },
    advisor: async () => ({ summary: "retry", rootCause: "timeout", expectedEvidence: "readback", action: "retry_same_phase" }),
    applyAction: async () => {}, persist: () => {}, log: () => {} };
}

test("stop during a failed handler prevents advice and a second platform attempt", async () => {
  const ctx = context();
  let stopped = false;
  let executions = 0;
  ctx.execute = async () => { executions++; stopped = true; throw new Error("late request failure"); };
  ctx.shouldCancel = () => stopped;
  ctx.advisor = async () => { throw new Error("must not ask AI after stop"); };
  assert.equal((await runPhaseWithRecovery(ctx)).status, "cancelled");
  assert.equal(executions, 1);
  assert.equal(ctx.run.recovery!.phases.itinerary.finalError, "用户中止了自动录入");
});

test("stop while advice is pending prevents its late retry action", async () => {
  const ctx = context();
  let stopped = false;
  let applied = 0;
  ctx.shouldCancel = () => stopped;
  ctx.advisor = async () => { stopped = true; return { summary: "retry", rootCause: "timeout", expectedEvidence: "readback", action: "reload_and_retry_phase" }; };
  ctx.applyAction = async () => { applied++; };
  assert.equal((await runPhaseWithRecovery(ctx)).status, "cancelled");
  assert.equal(applied, 0);
});

test("persistence failure is fatal and does not trigger a duplicate platform write", async () => {
  const ctx = context();
  let executions = 0;
  let writes = 0;
  ctx.execute = async () => { executions++; };
  ctx.persist = () => { if (++writes === 3) throw new Error("disk full"); };
  ctx.advisor = async () => { throw new Error("storage failure must not enter AI recovery"); };
  await assert.rejects(runPhaseWithRecovery(ctx), /disk full/);
  assert.equal(executions, 1);
});

test("whitespace-only advice cannot authorize another write", async () => {
  const ctx = context();
  ctx.advisor = async () => ({ summary: " ", rootCause: "timeout", expectedEvidence: "readback", action: "retry_same_phase" });
  ctx.applyAction = async () => { throw new Error("invalid advice must not be applied"); };
  assert.equal((await runPhaseWithRecovery(ctx)).status, "needs_user");
  assert.match(ctx.run.recovery!.phases.itinerary.finalError!, /不在白名单/);
});
