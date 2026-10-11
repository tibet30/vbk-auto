import assert from "node:assert/strict";
import test from "node:test";
import { AgentCore } from "../../src/main/agent/core.js";
import type { AgentApproval, AgentSnapshot } from "../../src/shared/contracts.js";

function harness(version = "new-cover", account = "fixture") {
  const approval: AgentApproval = { id: "old-approval", accountKey: "fixture", productVersion: "old-cover", intentVersion: "old-intent",
    scope: ["vbk.write_phase:presentation"], summary: "旧封面", status: "approved", createdAt: "t" };
  let snapshot: AgentSnapshot = { localProductId: "product", run: { id: "old-run", intentVersion: "old-intent", status: "paused", createdAt: "t", updatedAt: "t" },
    events: [{ id: "approved", runId: "old-run", type: "approval", content: "已批准", createdAt: "t", data: { approval } },
      { id: "remote", runId: "old-run", type: "tool_result", content: "旧录入已尝试", createdAt: "t", data: { write: true, remoteWrite: true } }] };
  let handoffs = 0;
  let repairs = 0;
  let repaired = false;
  let unavailable = false;
  const core = new AgentCore({
    model: { complete: async () => repaired
      ? { content: "当前方案已核验" }
      : { toolCalls: [{ id: `resolve-${repairs}`, name: "resolve_cover", arguments: {} }] } },
    tools: [{ name: "resolve_cover", description: "repair", parameters: {}, write: true, requiresApproval: false,
      execute: async () => { repairs++; repaired = true; return { content: "已保留原图并换用图库图", data: { productVersion: "library-cover" } }; } }],
    accountFor: async () => {
      if (unavailable) throw new Error("未登录");
      return { accountKey: account, productVersion: repaired ? "library-cover" : version };
    },
    requiresCompletionVerification: () => true,
    finishVerified: async (_id, context) => {
      assert.equal(context?.hadRemoteWrites, false);
      return { verified: false, finalApproval: { scope: approval.scope, summary: "当前图库封面待审批" } };
    },
    handoffApprovedWorkflow: () => { handoffs++; return true; },
  }, { getAgentSnapshot: () => structuredClone(snapshot), saveAgentSnapshot: value => { snapshot = structuredClone(value); } });
  return { core, snapshot: () => snapshot, handoffs: () => handoffs, repairs: () => repairs, unavailable: () => { unavailable = true; } };
}

for (const command of ["resume", "send"] as const) {
  test(`${command}: 改换封面后继续进入新核验轮次并生成新审批，不沿用旧授权`, async () => {
    const h = harness();
    if (command === "resume") await h.core.resume("product");
    else await h.core.send("product", "继续处理");
    await h.core.idle("product");
    const snapshot = h.snapshot();
    assert.equal(snapshot.run?.status, "waiting_approval");
    assert.notEqual(snapshot.run?.id, "old-run");
    assert.notEqual(snapshot.pendingApproval?.id, "old-approval");
    assert.equal(snapshot.pendingApproval?.productVersion, "library-cover");
    assert.equal(snapshot.pendingApproval?.status, "pending");
    assert.equal((snapshot.events[0]!.data?.approval as AgentApproval).status, "invalidated");
    assert.equal(h.repairs(), 1);
    assert.equal(h.handoffs(), 0);
    await h.core.resume("product");
    assert.equal(h.snapshot().pendingApproval?.id, snapshot.pendingApproval?.id);
    assert.equal(h.handoffs(), 0);
  });
}

test("未更改的已审批方案继续从确定性录入检查点恢复", async () => {
  const h = harness("old-cover");
  await h.core.resume("product");
  assert.equal(h.handoffs(), 1);
  assert.equal(h.repairs(), 0);
  assert.equal(h.snapshot().run?.id, "old-run");
});

test("无法核验登录时保留暂停，不能撤销授权或启动新写入", async () => {
  const h = harness();
  h.unavailable();
  await h.core.resume("product");
  assert.equal(h.snapshot().run?.status, "paused");
  assert.equal((h.snapshot().events[0]!.data?.approval as AgentApproval).status, "approved");
  assert.equal(h.handoffs(), 0);
  assert.equal(h.repairs(), 0);
});
