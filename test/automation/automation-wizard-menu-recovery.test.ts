import assert from "node:assert/strict";
import test from "node:test";
import type { AutomationRun } from "../../src/shared/contracts.js";
import { prepareWizardMenuRecovery } from "../../src/main/automation/automation.main/automation.main.resume-state.js";

const PHASES = ["basic", "presentation", "itinerary", "package", "preflight"];
type ResumableStatus = "failed" | "cancelled" | "queued";

function historical(status: ResumableStatus): AutomationRun {
  return {
    id: `historical-${status}`,
    status,
    currentPhase: "itinerary",
    phases: PHASES.map((phase) => ({
      phase,
      status: ["basic", "presentation", "itinerary"].includes(phase) ? "completed" : "pending",
    })),
    logs: [{ at: "2026-10-14T00:00:00.000Z", level: "error", message: "历史断点" }],
  };
}

test("b175 的 -80 历史状态回卷到 basic，并只标记两个官方下一步", () => {
  const previous = historical("failed");
  previous.phases.find(phase => phase.phase === "itinerary")!.status = "failed";
  const before = structuredClone(previous);

  const result = prepareWizardMenuRecovery(
    previous, PHASES, "itinerary", "basic", true, "2026-10-14T06:10:00.000Z",
  );

  assert.ok(result);
  assert.equal(result.retryFrom, "basic");
  assert.deepEqual([...result.wizardAdvanceOnly], ["basic", "presentation"]);
  assert.equal(result.run.currentPhase, "basic");
  assert.deepEqual(result.run.phases.map(phase => phase.status), ["pending", "pending", "pending", "pending", "pending"]);
  assert.match(result.run.logs.at(-1)?.message ?? "", /官方下一步恢复/);
  assert.deepEqual(previous, before, "纯恢复规划不得改写原始持久化快照");
});

test("-70 只回卷 presentation，前置 basic 的已完成证据保留", () => {
  const previous = historical("cancelled");
  previous.phases.find(phase => phase.phase === "package")!.status = "failed";

  const result = prepareWizardMenuRecovery(previous, PHASES, "package", "presentation", true);

  assert.ok(result);
  assert.equal(result.retryFrom, "presentation");
  assert.deepEqual([...result.wizardAdvanceOnly], ["presentation"]);
  assert.deepEqual(result.run.phases.map(phase => phase.status), ["completed", "pending", "pending", "pending", "pending"]);
});

test("failed、cancelled、queued 都能用历史证据回卷 VBK 向导", () => {
  for (const status of ["failed", "cancelled", "queued"] as const) {
    const result = prepareWizardMenuRecovery(historical(status), PHASES, "preflight", "basic", true);
    assert.ok(result, status);
    assert.equal(result.retryFrom, "basic", status);
    assert.equal(result.run.status, "running", status);
  }
});

test("-60 只回卷 itinerary，不伪装成 basic 或 presentation 的官方下一步", () => {
  const previous = historical("failed");
  previous.phases.find(phase => phase.phase === "package")!.status = "failed";

  const result = prepareWizardMenuRecovery(previous, PHASES, "package", "itinerary", true);

  assert.ok(result);
  assert.equal(result.retryFrom, "itinerary");
  assert.deepEqual([...result.wizardAdvanceOnly], []);
  assert.deepEqual(result.run.phases.map(phase => phase.status), ["completed", "completed", "pending", "pending", "pending"]);
});

test("缺少历史完成证据或没有官方菜单阶段时，不能偷偷回卷", () => {
  const previous = historical("failed");
  previous.phases.find(phase => phase.phase === "itinerary")!.status = "failed";
  assert.equal(prepareWizardMenuRecovery(previous, PHASES, "itinerary", undefined, true), undefined);
  assert.throws(() => prepareWizardMenuRecovery(previous, PHASES, "itinerary", "basic", false), /缺少可安全复用/);

  previous.phases.find(phase => phase.phase === "presentation")!.status = "pending";
  assert.throws(() => prepareWizardMenuRecovery(previous, PHASES, "itinerary", "basic", true), /缺少可安全复用/);
});
