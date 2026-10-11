import assert from "node:assert/strict";
import { ProductTaskScheduler } from "../../src/main/application/product-task-scheduler.js";
import test from "node:test";
import { AgentCore } from "../../src/main/agent/core.js";
import type { AgentSnapshot, ProductDetail, ProductWorkflowTask } from "../../src/shared/contracts.js";

test("completed task recovery reuses approval and hands off without replanning", async () => {
  let snapshot: AgentSnapshot = {
    localProductId: "saved-parent",
    run: { id: "old", status: "completed", createdAt: "x", updatedAt: "x", intentVersion: "approved" },
    events: [{ id: "approval-event", runId: "old", type: "approval", content: "用户已授权", createdAt: "x", data: {
      approval: { id: "approval", productVersion: "version", accountKey: "account", intentVersion: "approved",
        scope: ["vbk.write_phase:trafficLine"], summary: "交通录入", status: "approved", createdAt: "x" },
    } }],
  };
  let modelCalls = 0;
  let handoffs = 0;
  const core = new AgentCore({
    model: { complete: async () => { modelCalls++; return { content: "unexpected planning" }; } },
    tools: [], accountFor: async () => ({ accountKey: "account", productVersion: "version" }),
    handoffApprovedWorkflow: (_id, approval) => {
      handoffs++;
      assert.deepEqual(approval.scope, ["vbk.write_phase:trafficLine"]);
      assert.equal(approval.intentVersion, "approved");
      return true;
    },
  }, { getAgentSnapshot: () => structuredClone(snapshot), saveAgentSnapshot: value => { snapshot = structuredClone(value); } });
  let task = { id: "task", localProductId: "saved-parent", status: "failed", stage: "automation", progress: 90 } as ProductWorkflowTask;
  const scheduler = new ProductTaskScheduler({
    db: {
      getProduct: () => ({ id: "saved-parent", productId: "parent" } as ProductDetail),
      getAgentSnapshot: () => snapshot, getWorkflowTask: () => task, latestWorkflowTaskForProduct: () => task,
      listWorkflowTasks: () => [task], createWorkflowTask: () => { throw new Error("不能创建替代任务"); },
      updateWorkflowTask: (_id, patch) => { task = { ...task, ...patch }; return task; },
      abandonWorkflowTask: () => { throw new Error("不能废弃当前任务"); },
    },
    agent: core, emitTask: () => undefined, emitProduct: () => undefined,
  });
  await scheduler.resume("task", "from_error");
  assert.equal(task.retryMode, "from_error");
  await core.idle("saved-parent");
  assert.equal(modelCalls, 0);
  assert.equal(handoffs, 1);
  assert.notEqual(snapshot.run?.id, "old");
  assert.ok(snapshot.events.some(event => event.runId === snapshot.run?.id && event.data?.recoveredApproval === true));
});
