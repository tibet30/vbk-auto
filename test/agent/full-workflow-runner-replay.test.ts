import test from "node:test";
import assert from "node:assert/strict";
import { DraftAutomation } from "../../src/main/automation/automation.main/automation.main.class.js";

for (const [marker, expected] of [["old", undefined], [undefined, "itinerary"], ["stale", "itinerary"]] as const) {
  test(`failed workflow uses ${marker === "old" ? "full replay" : "normal phase recovery"}`, async () => {
    const product: any = { id: "p", productId: "79232466", product: {}, automation: {
      id: "old", status: "failed", logs: [], phases: [{ phase: "itinerary", status: "failed" }],
    } };
    const approval = { id: "a", status: "approved", replayOfAutomationRunId: marker };
    const calls: unknown[] = [];
    const instance: any = {
      db: { getProduct: () => product, getAgentSnapshot: () => ({ run: { id: "r" }, events: [
        { runId: "r", type: "approval", data: { approval } },
      ] }) }, agentWriteGuard: () => {},
      runApprovedLocked: (_id: string, phase: string | undefined) => { calls.push(phase); product.automation.status = "succeeded"; },
    };
    await DraftAutomation.prototype.executeApprovedWorkflow.call(instance, "p");
    assert.deepEqual(calls, [expected]);
  });
}

test('确定性执行器返回失败时保留具体阶段错误，不进入完成核对', async () => {
  const product: any = { id: 'p', productId: '79235816', product: {}, automation: {
    id: 'old', status: 'failed', currentPhase: 'itinerary', logs: [],
    phases: [{ phase: 'itinerary', status: 'failed' }],
    recovery: { phases: { itinerary: { state: 'needs_user', finalError: '平台行程版本不完整' } } },
  } };
  const instance: any = {
    db: { getProduct: () => product, getAgentSnapshot: () => ({ run: { id: 'r' }, events: [
      { runId: 'r', type: 'approval', data: { approval: { id: 'a', status: 'approved' } } },
    ] }) }, agentWriteGuard: () => {}, runApprovedLocked: async () => {},
  };
  await assert.rejects(DraftAutomation.prototype.executeApprovedWorkflow.call(instance, 'p'), /平台行程版本不完整/);
});
