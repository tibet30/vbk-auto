import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

test("final approval delegates phase ordering to automation instead of exposing a model write tool", async () => {
  const [tools, setup, automation] = await Promise.all([
    readFile(new URL("../../src/main/agent/integration.ts", import.meta.url), "utf8"),
    readFile(new URL("../../src/main/agent/integration-setup.ts", import.meta.url), "utf8"),
    readFile(new URL("../../src/main/automation/automation.main/automation.main.class.ts", import.meta.url), "utf8"),
  ]);
  assert.doesNotMatch(tools, /name:\s*["']execute_vbk_phase["']/);
  assert.match(setup, /handoffApprovedWorkflow[\s\S]*executeApprovedWorkflow/);
  assert.match(automation, /async executeApprovedWorkflow[\s\S]*runApprovedLocked/);
});

test("agent POI writes refresh satisfied research tasks after binding", async () => {
  const tools = await readFile(new URL("../../src/main/agent/integration.ts", import.meta.url), "utf8");
  assert.match(tools, /refreshSatisfiedResearchTasks/);
  assert.match(tools, /select_itinerary_poi[\s\S]*refreshSatisfiedResearchTasks\(deps\.db/);
  assert.match(tools, /resolve_itinerary_pois[\s\S]*refreshSatisfiedResearchTasks\(deps\.db/);
});

test("phase-A approval gates refresh research and require local readiness before VBK", async () => {
  const setup = await readFile(new URL("../../src/main/agent/integration-setup.ts", import.meta.url), "utf8");
  assert.match(setup, /approvalPrecondition:[\s\S]*refreshSatisfiedResearchTasks\(db, localProductId\)/);
  assert.match(setup, /approvalPrecondition:[\s\S]*本地方案尚未准备完成，不能进入 VBK 录入/);
  assert.match(setup, /finishVerified:[\s\S]*refreshSatisfiedResearchTasks\(db, localProductId\)/);
  assert.match(setup, /approvalPrecondition:[\s\S]*emitProduct\(readyProduct\)/);
});

test("agent local writes emit product updates so confirmation readiness cannot go stale", async () => {
  const tools = await readFile(new URL("../../src/main/agent/integration.ts", import.meta.url), "utf8");
  assert.match(tools, /if \(changedSections\.length\) deps\.emitProduct\(after\)/);
});

test("phase-B failure recovery stays on the deterministic runner", async () => {
  const [core, handoff, setup, automation] = await Promise.all([
    readFile(new URL("../../src/main/agent/core.ts", import.meta.url), "utf8"),
    readFile(new URL("../../src/main/agent/core-handoff.ts", import.meta.url), "utf8"),
    readFile(new URL("../../src/main/agent/integration-setup.ts", import.meta.url), "utf8"),
    readFile(new URL("../../src/main/automation/automation.main/automation.main.class.ts", import.meta.url), "utf8"),
  ]);
  assert.match(setup, /pauseApprovedWorkflow[\s\S]*executeApprovedWorkflow|executeApprovedWorkflow[\s\S]*pauseApprovedWorkflow/);
  assert.match(core, /不会改回 AI 规划/);
  assert.match(handoff, /refreshFingerprint/);
  assert.match(automation, /failedAutomationResumePhase/);
  assert.match(automation, /executeApprovedWorkflow[\s\S]*failedAutomationResumePhase/);
});
