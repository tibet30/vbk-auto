import test from "node:test";
import assert from "node:assert/strict";
import type { AdvisorAction, PhaseRecovery } from "../src/shared/contracts.js";

test("recovery 契约暴露给 runner 与 advisor", () => {
  const sample: PhaseRecovery = { phase: "basic", state: "running", attempts: [] };
  const action: AdvisorAction = "retry_same_phase";
  assert.equal(sample.state, "running");
  assert.equal(action, "retry_same_phase");
});