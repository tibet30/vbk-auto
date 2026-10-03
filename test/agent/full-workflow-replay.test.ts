import assert from "node:assert/strict";
import test from "node:test";
import { AgentCore } from "../../src/main/agent/core.js";
import { isFullWorkflowReplayInstruction, requestsFreshAutomationRun } from "../../src/main/agent/core-workflow-replay.js";
import type { AgentCoreDependencies } from "../../src/main/agent/types.js";
import type { AgentSnapshot } from "../../src/shared/contracts.js";

const instruction = "保持当前方案不变，从基础信息开始重新执行完整 VBK 录入，不提交审核、不发布。";
function fixture() {
  let saved: AgentSnapshot = { localProductId: "p", run: {
    id: "old-agent", status: "completed", createdAt: "x", updatedAt: "x",
  }, events: [] };
  const handoffs: string[] = [];
  const deps: AgentCoreDependencies = {
    tools: [], model: { complete: async () => { throw new Error("must not invoke model for explicit replay"); } },
    accountFor: async () => ({ accountKey: "account", productVersion: "unchanged" }),
    prepareWorkflowReplay: () => ({ scope: ["vbk.write_phase:basic", "vbk.write_phase:preflight"], summary: "完整重录", automationRunId: "old-automation" }),
    approvalPrecondition: async () => undefined,
    handoffApprovedWorkflow: (_id, approval) => { handoffs.push(approval.replayOfAutomationRunId ?? "normal"); return true; },
  };
  const core = new AgentCore(deps, {
    getAgentSnapshot: () => structuredClone(saved), saveAgentSnapshot: value => { saved = structuredClone(value); },
  });
  return { core, deps, handoffs, get: () => saved, set: (value: AgentSnapshot) => { saved = value; } };
}

test("completed product explicit replay creates a new scoped approval and executes rather than reporting old success", async () => {
  const f = fixture();
  const next = await f.core.send("p", instruction);
  assert.notEqual(next.run?.id, "old-agent");
  assert.equal(next.run?.status, "waiting_approval");
  assert.equal(next.pendingApproval?.replayOfAutomationRunId, "old-automation");
  assert.equal((await f.core.get("p")).pendingApproval?.id, next.pendingApproval?.id);
  assert.deepEqual(f.handoffs, []);
  const approval = next.pendingApproval!;
  assert.equal(requestsFreshAutomationRun(approval, "old-automation"), true);
  await f.core.approve("p", { approvalId: approval.id, productVersion: approval.productVersion });
  assert.deepEqual(f.handoffs, ["old-automation"]);
  // Once a new run exists, later recovery resumes it; it does not replay from basic again.
  assert.equal(requestsFreshAutomationRun(approval, "new-automation"), false);
});

test("explicit full replay rejects uncertain writes and running jobs before authorising new writes", async () => {
  for (const uncertain of [false, true]) {
    const f = fixture(); const state = f.get();
    if (uncertain) state.uncertainWrite = { toolCallId: "write", message: "timeout", createdAt: "x" };
    else state.run!.status = "running";
    f.set(state);
    await assert.rejects(f.core.send("p", instruction), /尚未|不能/);
    assert.deepEqual(f.handoffs, []);
    assert.equal(f.get().pendingApproval, undefined);
  }
});

test("replay still checks readiness and fresh account/product identity", async () => {
  const f = fixture(); f.deps.approvalPrecondition = async () => "酒店缺失";
  await assert.rejects(f.core.send("p", instruction), /酒店缺失/);
  assert.equal(f.get().pendingApproval, undefined);
  f.deps.approvalPrecondition = async () => undefined;
  const pending = (await f.core.send("p", instruction)).pendingApproval!;
  f.deps.accountFor = async () => ({ accountKey: "another-account", productVersion: "unchanged" });
  await f.core.approve("p", { approvalId: pending.id, productVersion: pending.productVersion });
  assert.deepEqual(f.handoffs, []);
  assert.equal(f.get().pendingApproval, undefined);
});

test("a paused agent can restart a confirmed failed automation, while unknown or successful paused jobs remain blocked", async () => {
  for (const status of [undefined, "succeeded", "failed"] as const) {
    const f = fixture(); const snapshot = f.get(); snapshot.run!.status = "paused"; f.set(snapshot);
    f.deps.prepareWorkflowReplay = () => ({ scope: ["vbk.write_phase:basic"], summary: "完整重录",
      automationRunId: "old-automation", automationRunStatus: status });
    if (status === "failed") {
      assert.equal((await f.core.send("p", instruction)).run?.status, "waiting_approval");
    } else {
      await assert.rejects(f.core.send("p", instruction), /尚未结束/);
    }
  }
});

test("recovery, queries, prohibited replay and one-phase reruns are not full replay instructions", () => {
  for (const text of ["继续执行", "再试一次", "是否可以重新执行完整 VBK 录入？", "不要重新执行完整 VBK 录入", "只重跑酒店阶段，别重新录入全部", "重新生成全部方案", "重新执行酒店资源阶段", "重新录入全部阶段，成人价改成1880", "修改酒店后重新执行完整VBK录入"]) {
    assert.equal(isFullWorkflowReplayInstruction(text), false, text);
  }
  for (const text of [instruction, "把产品再录入一次", "重新录入全部阶段"]) {
    assert.equal(isFullWorkflowReplayInstruction(text), true, text);
  }
});
