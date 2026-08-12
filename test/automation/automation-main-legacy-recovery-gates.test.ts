import test from "node:test";
import assert from "node:assert/strict";
import type { AutomationRun } from "../../src/shared/contracts.js";
import { isLegacyScreenshotFalseFailure } from "../../src/main/automation/automation.main/automation.main.legacy-recovery.js";

function completedRun(overrides: Partial<AutomationRun> = {}): AutomationRun {
  return {
    id: "run-stuck",
    status: "failed",
    phases: [{ phase: "preflight", status: "completed" }],
    logs: [{ at: "2026-08-12T01:00:00.000Z", message: "Cannot take screenshot with 0 width", level: "error" }],
    ...overrides,
  };
}

test("legacy recovery requires currentPhase to be undefined", () => {
  assert.equal(isLegacyScreenshotFalseFailure(completedRun({ currentPhase: "preflight" })), false);
});
