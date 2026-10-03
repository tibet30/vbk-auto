import test from "node:test";
import assert from "node:assert/strict";
import type { AgentApproval, AgentSnapshot } from "../../src/shared/contracts.js";
import { ProductWorkflowCoordinator } from "../../src/main/application/product-workflow-coordinator.js";
import { runQueuedApprovedWorkflow } from "../../src/main/agent/queued-approved-workflow.js";

const approval = { id: "approval", status: "approved", scope: ["vbk.write_phase:basic"] } as AgentApproval;
function snapshot(status = "running", approvalId = approval.id): AgentSnapshot {
  return { run: { id: "run", status }, events: [{ runId: "run", type: "approval", data: { approval: { ...approval, id: approvalId } } }] } as AgentSnapshot;
}
function blocker(coordinator: ProductWorkflowCoordinator) {
  let release!: () => void;
  let start!: () => void;
  const started = new Promise<void>(resolve => { start = resolve; });
  const done = coordinator.runExclusive("first", "automation", async () => {
    start(); await new Promise<void>(resolve => { release = resolve; });
  });
  return { started, done, release: () => release() };
}

test("授权的第二个产品等待前一个录入完成，随后自动执行并完成", async () => {
  const coordinator = new ProductWorkflowCoordinator(); const first = blocker(coordinator); await first.started;
  const events: string[] = [];
  const job = runQueuedApprovedWorkflow({ id: "second", approval, coordinator, snapshot: () => snapshot(),
    execute: async () => { events.push("write"); }, complete: async () => { events.push("complete"); }, pause: async () => { events.push("pause"); } });
  assert.deepEqual(events, []); first.release(); await Promise.all([first.done, job]);
  assert.deepEqual(events, ["write", "complete"]);
});

test("排队期间暂停、放弃或替换授权时，不写平台、不误报完成，并释放队列", async () => {
  for (const current of [snapshot("paused"), snapshot("abandoned"), snapshot("running", "new-approval")]) {
    const coordinator = new ProductWorkflowCoordinator(); const first = blocker(coordinator); await first.started;
    let state = snapshot(); const events: string[] = [];
    const job = runQueuedApprovedWorkflow({ id: "second", approval, coordinator, snapshot: () => state,
      execute: async () => { events.push("write"); }, complete: async () => { events.push("complete"); }, pause: async () => { events.push("pause"); } });
    state = current; first.release(); await Promise.all([first.done, job]);
    assert.deepEqual(events, ["pause"]);
    assert.equal(await coordinator.runExclusive("third", "automation", async () => "next"), "next");
  }
});

test("排队后真正执行失败才暂停该产品，后续产品仍可执行", async () => {
  const coordinator = new ProductWorkflowCoordinator(); const events: string[] = [];
  await runQueuedApprovedWorkflow({ id: "failed", approval, coordinator, snapshot: () => snapshot(),
    execute: async () => { throw new Error("remote error"); }, complete: async () => { events.push("complete"); }, pause: async message => { events.push(message); } });
  assert.deepEqual(events, ["remote error"]);
  assert.equal(await coordinator.runExclusive("next", "automation", async () => "next"), "next");
});

test("多个授权产品依次录入，排队的产品不能同时修改方案", async () => {
  const coordinator = new ProductWorkflowCoordinator();
  const first = blocker(coordinator); await first.started;
  const events: string[] = [];
  const jobs = ["second", "third", "fourth"].map(id => runQueuedApprovedWorkflow({
    id, approval, coordinator, snapshot: () => snapshot(),
    execute: async () => { events.push(id); await Promise.resolve(); },
    complete: async () => {}, pause: async message => { assert.fail(message); },
  }));
  await assert.rejects(coordinator.runExclusive("third", "planning", async () => {}), /等待 VBK/);
  first.release(); await Promise.all([first.done, ...jobs]);
  assert.deepEqual(events, ["second", "third", "fourth"]);
});
