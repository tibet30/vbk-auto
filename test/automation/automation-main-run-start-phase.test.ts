import test from "node:test";
import assert from "node:assert/strict";
import type { AutomationRun } from "../../src/shared/contracts.js";
import { completeVerifiedSaleControlPhase, initializeAutomationStartPhase } from "../../src/main/automation/automation.main/automation.main.run-state.js";

function makeRun(): AutomationRun {
  return {
    id: "run-start-phase",
    status: "running",
    phases: [
      { phase: "basic", status: "pending" },
      { phase: "presentation", status: "pending" },
    ],
    logs: [],
  };
}

test("首次无 productId：销售控制是当前阶段，产品信息仍为 pending", () => {
  const run = makeRun();

  initializeAutomationStartPhase(run, undefined);

  assert.equal(run.currentPhase, "saleControl");
  assert.equal(run.phases.find((phase) => phase.phase === "basic")?.status, "pending");
  assert.equal(run.phases.find((phase) => phase.phase === "presentation")?.status, "pending");
});

test("已有 productId：保持从产品信息阶段开始的重跑语义", () => {
  const run = makeRun();

  initializeAutomationStartPhase(run, "7654321");

  assert.equal(run.currentPhase, "basic");
  assert.equal(run.phases.find((phase) => phase.phase === "basic")?.status, "running");
});

test("销售控制远端回读通过：先完成销售控制，再切换到产品信息", () => {
  const run = makeRun();
  initializeAutomationStartPhase(run, undefined);

  completeVerifiedSaleControlPhase(run);

  assert.equal(run.recovery?.phases.saleControl.state, "completed");
  assert.equal(run.currentPhase, "basic");
  assert.equal(run.phases.find((phase) => phase.phase === "basic")?.status, "running");
});
