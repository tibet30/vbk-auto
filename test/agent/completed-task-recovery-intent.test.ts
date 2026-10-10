import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { AgentCore } from "../../src/main/agent/core.js";
import type { AgentSnapshot } from "../../src/shared/contracts.js";

test("completed task recovery reuses approval and hands off without replanning", async () => {
  // Exercise the actual recovery instruction emitted by the task IPC handler.
  const ipc = readFileSync(new URL("../../src/main/ipc/remote-product-ipc.ts", import.meta.url), "utf8");
  const content = ipc.match(/const continued = await context\.agentCore\.send\(\s*task\.localProductId,\s*"([^"]+)"/u)?.[1];
  assert.ok(content);
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
  await core.send("saved-parent", content);
  await core.idle("saved-parent");
  assert.equal(modelCalls, 0);
  assert.equal(handoffs, 1);
  assert.notEqual(snapshot.run?.id, "old");
  assert.ok(snapshot.events.some(event => event.runId === snapshot.run?.id && event.data?.recoveredApproval === true));
});
