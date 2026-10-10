import assert from "node:assert/strict";
import test from "node:test";
import { AgentCore } from "../../src/main/agent/core.js";
import { agentProductVersion, recoverEquivalentApproval } from "../../src/main/agent/integration-gates.js";
import type { AgentSnapshot, ProductDetail } from "../../src/shared/contracts.js";

const product: ProductDetail = { id: "parent", name: "成都2天1晚", status: "draft_saved", productId: "123",
  updatedAt: "x", messages: [], researchTasks: [], vbkAccount: "account",
  product: { basicInfo: { meetingCity: "成都" }, commercial: { pricing: { adult: 1000 } } } };
function checkpoint(): AgentSnapshot {
  return { localProductId: product.id,
    run: { id: "recovery", status: "paused", createdAt: "x", updatedAt: "x", intentVersion: "recovery-intent" },
    events: [
      { id: "approval-event", runId: "original", type: "approval", createdAt: "x", content: "用户已授权", data: {
        approval: { id: "approval", accountKey: "account", productVersion: agentProductVersion(product),
          intentVersion: "original-intent", scope: ["vbk.write_phase:trafficLine"], status: "approved", summary: "交通", createdAt: "x" },
      } },
      { id: "legacy-recovery", runId: "recovery", type: "user", createdAt: "x",
        content: "请继续当前产品规划与录入。先读取已有状态，不要重置或重复已验证内容。" },
    ] };
}

test("historical task recovery appends an audited approval in the current run and bypasses the model", async () => {
  let snapshot = checkpoint();
  let modelCalls = 0;
  let handoffs = 0;
  const core = new AgentCore({ tools: [],
    model: { complete: async () => { modelCalls++; return { content: "unexpected planning" }; } },
    accountFor: async () => ({ accountKey: "account", productVersion: agentProductVersion(product) }),
    recoverApproval: async (_id, value) => recoverEquivalentApproval(product, value),
    handoffApprovedWorkflow: (_id, approval) => {
      handoffs++;
      assert.deepEqual(approval.scope, ["vbk.write_phase:trafficLine"]);
      assert.equal(approval.trafficRouteReviewAuthorized, undefined);
      return true;
    },
  }, { getAgentSnapshot: () => structuredClone(snapshot), saveAgentSnapshot: value => { snapshot = structuredClone(value); } });
  await core.resume(product.id);
  await core.idle(product.id);
  assert.equal(modelCalls, 0);
  assert.equal(handoffs, 1);
  assert.equal(snapshot.events[0]!.runId, "original");
  assert.ok(snapshot.events.some(event => event.type === "approval" && event.runId === "recovery"
    && event.data?.recoveredApproval === true));
});

test("changed business values and post-approval edit requests cannot reuse historical authority", () => {
  const changed = structuredClone(product);
  (changed.product.commercial as { pricing: { adult: number } }).pricing.adult = 2000;
  assert.equal(recoverEquivalentApproval(changed, checkpoint()), undefined);
  const edited = checkpoint();
  edited.events.push({ id: "edit", runId: "recovery", type: "user", createdAt: "x", content: "把成人价改成2000后继续" });
  assert.equal(recoverEquivalentApproval(product, edited), undefined);
});
