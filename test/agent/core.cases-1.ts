import assert from "node:assert/strict";
import test from "node:test";
import { AgentCore, isPendingApprovalStatusFollowup, preservesApprovedIntent } from "../../src/main/agent/core.js";
import type { AgentCoreDependencies } from "../../src/main/agent/types.js";
import type { AgentSnapshot } from "../../src/shared/contracts.js";

function harness(results: Array<{ content?: string; toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }> }>) {
  const saved = new Map<string, AgentSnapshot>();
  const deps: AgentCoreDependencies = {
    model: { complete: async () => results.shift() ?? { content: "done" } },
    tools: [{ name: "read", description: "read", parameters: {}, execute: async () => ({ content: "ok" }) }],
    accountFor: async () => ({ accountKey: "account", productVersion: "version" }),
    id: (() => { let n = 0; return () => `id-${++n}`; })(),
    now: () => new Date("2026-09-05T00:00:00.000Z"),
  };
  return { core: new AgentCore(deps, { getAgentSnapshot: (id) => saved.get(id), saveAgentSnapshot: (value) => { saved.set(value.localProductId, structuredClone(value)); } }), saved, deps };
}

test("a terminal readback tool completes the Agent run without requesting approval", async () => {
  const { core, deps } = harness([
    { toolCalls: [{ id: "recovery", name: "read", arguments: {} }] },
    { toolCalls: [{ id: "approval", name: "request_approval", arguments: { scope: ["vbk.write_phase:trafficLine"], summary: "录入交通" } }] },
  ]);
  deps.tools[0]!.execute = async () => ({ content: "母产品只读核验完成", terminal: true });

  await core.send("terminal-recovery", "继续母产品只读核验");
  await core.idle("terminal-recovery");

  const snapshot = await core.get("terminal-recovery");
  assert.equal(snapshot.run?.status, "completed");
  assert.ok(snapshot.events.some((event) => event.type === "tool_result" && event.data?.toolCallId === "recovery"));
  assert.equal(snapshot.events.some((event) => event.type === "tool_call" && event.data?.toolCallId === "approval"), false);
});
test("recovery-only wording preserves an approved intent without depending on one exact phrase", () => {
  assert.equal(preservesApprovedIntent("继续"), true);
  assert.equal(preservesApprovedIntent("从报错处继续执行"), true);
  assert.equal(preservesApprovedIntent("继续吧"), true);
  assert.equal(preservesApprovedIntent("接着做"), true);
  assert.equal(preservesApprovedIntent("再试一次"), true);
  assert.equal(preservesApprovedIntent("从刚才继续"), true);
  assert.equal(preservesApprovedIntent("不要修改行程，保持当前产品方案，只从 hotelResource 阶段重试"), true);
  assert.equal(preservesApprovedIntent("继续，把成人价改成 1880"), false);
  assert.equal(preservesApprovedIntent("修改酒店后继续"), false);
});

test("a recommendation-reason follow-up keeps a pending final approval intact", async () => {
  const { core, saved, deps } = harness([]);
  deps.approvalPrecondition = async () => undefined;
  saved.set("pending-recommendations", {
    localProductId: "pending-recommendations",
    run: { id: "run", status: "waiting_approval", createdAt: "x", updatedAt: "x", intentVersion: "intent" },
    pendingApproval: {
      id: "approval", productVersion: "version", accountKey: "account", intentVersion: "intent",
      scope: ["vbk.write_phase:presentation"], summary: "最终确认", status: "pending", createdAt: "x",
    },
    events: [],
  });

  assert.equal(isPendingApprovalStatusFollowup("把待处理事项处理掉"), true);
  assert.equal(isPendingApprovalStatusFollowup("推荐理由"), true);
  assert.equal(isPendingApprovalStatusFollowup("把成人价改成 1880"), false);
  assert.equal(isPendingApprovalStatusFollowup("修改推荐理由"), false);
  assert.equal(isPendingApprovalStatusFollowup("重新生成推荐理由"), false);
  assert.equal(isPendingApprovalStatusFollowup("把推荐理由改短一点"), false);

  const next = await core.send("pending-recommendations", "把待处理事项处理掉");
  assert.equal(next.pendingApproval?.id, "approval");
  assert.equal(next.run?.status, "waiting_approval");
  assert.equal(next.events.some((event) => event.data?.pendingApprovalRetained === true), true);
});

test("a status follow-up drops a stale approval when local readiness no longer passes", async () => {
  const { core, saved, deps } = harness([{ content: "done" }]);
  deps.approvalPrecondition = async () => "本地方案尚未准备完成，不能进入 VBK 录入：推荐理由";
  saved.set("stale-approval", {
    localProductId: "stale-approval",
    run: { id: "run", status: "waiting_approval", createdAt: "x", updatedAt: "x", intentVersion: "intent" },
    pendingApproval: {
      id: "approval", productVersion: "version", accountKey: "account", intentVersion: "intent",
      scope: ["vbk.write_phase:presentation"], summary: "最终确认", status: "pending", createdAt: "x",
    },
    events: [],
  });

  const next = await core.send("stale-approval", "把待处理事项处理掉");
  assert.equal(next.pendingApproval, undefined);
  assert.equal(next.events.some((event) => event.data?.pendingApprovalRetained === true), false);
  await core.idle("stale-approval");
});

test("get drops a stale pending approval before the renderer can show final confirmation", async () => {
  const { core, saved, deps } = harness([]);
  deps.approvalPrecondition = async () => "本地方案尚未准备完成，不能进入 VBK 录入：产品封面";
  saved.set("stale-approval-get", {
    localProductId: "stale-approval-get",
    run: { id: "run", status: "waiting_approval", createdAt: "x", updatedAt: "x", intentVersion: "intent" },
    pendingApproval: {
      id: "approval", productVersion: "version", accountKey: "account", intentVersion: "intent",
      scope: ["vbk.write_phase:presentation"], summary: "最终确认", status: "pending", createdAt: "x",
    },
    events: [],
  });

  const next = await core.get("stale-approval-get");
  assert.equal(next.pendingApproval, undefined);
  assert.equal(next.run?.status, "paused");
  assert.ok(next.events.some((event) => /最终确认已失效/.test(event.content)));
});

test("resume drops a stale pending approval and schedules automatic repair", async () => {
  const { core, saved, deps } = harness([]);
  let modelCalls = 0;
  deps.model = { complete: async () => { modelCalls += 1; return { content: "done" }; } };
  deps.approvalPrecondition = async () => "本地方案尚未准备完成，不能进入 VBK 录入：产品封面";
  saved.set("stale-approval-resume", {
    localProductId: "stale-approval-resume",
    run: { id: "run", status: "waiting_approval", createdAt: "x", updatedAt: "x", intentVersion: "intent" },
    pendingApproval: {
      id: "approval", productVersion: "version", accountKey: "account", intentVersion: "intent",
      scope: ["vbk.write_phase:presentation"], summary: "最终确认", status: "pending", createdAt: "x",
    },
    events: [],
  });

  const resumed = await core.resume("stale-approval-resume");
  assert.equal(resumed.pendingApproval, undefined);
  assert.equal(resumed.run?.status, "running");
  await core.idle("stale-approval-resume");
  assert.equal(modelCalls, 1);
});

test("an explicit recommendation edit does not retain a pending final approval", async () => {
  const { core, saved } = harness([{ content: "done" }]);
  saved.set("edit-recommendations", {
    localProductId: "edit-recommendations",
    run: { id: "run", status: "waiting_approval", createdAt: "x", updatedAt: "x", intentVersion: "intent" },
    pendingApproval: {
      id: "approval", productVersion: "version", accountKey: "account", intentVersion: "intent",
      scope: ["vbk.write_phase:presentation"], summary: "最终确认", status: "pending", createdAt: "x",
    },
    events: [],
  });

  const next = await core.send("edit-recommendations", "修改推荐理由");
  assert.equal(next.pendingApproval, undefined);
  assert.equal(next.events.some((event) => event.data?.pendingApprovalRetained === true), false);
  await core.idle("edit-recommendations");
});

test("recovery-only send keeps the existing approved intent version", async () => {
  const { core, saved } = harness([{ content: "done" }]);
  saved.set("resume-approved", {
    localProductId: "resume-approved",
    run: { id: "run", status: "paused", createdAt: "x", updatedAt: "x", intentVersion: "approved-intent" },
    events: [{
      id: "approval", runId: "run", type: "approval", content: "用户已授权", createdAt: "x",
      data: { approval: { id: "a", productVersion: "version", accountKey: "account", scope: ["write"], summary: "write", status: "approved", createdAt: "x", intentVersion: "approved-intent" } },
    }],
  });
  const resumed = await core.send("resume-approved", "从报错处继续执行");
  assert.equal(resumed.run?.intentVersion, "approved-intent");
  assert.equal(resumed.events.find((event) => event.type === "user")?.data?.approvalPreservingRecovery, true);
  await core.idle("resume-approved");
});

test("resume button migrates an equivalent approval before retrying a write", async () => {
  const { core, saved, deps } = harness([
    { toolCalls: [{ id: "write-after-resume", name: "write", arguments: {} }] },
    { content: "done" },
  ]);
  let writes = 0;
  deps.tools = [{
    name: "write", description: "write", parameters: {}, write: true,
    approvalScope: ["write"],
    execute: async () => { writes += 1; return { content: "written" }; },
  }];
  deps.recoverApproval = async () => ({
    id: "approval", productVersion: "version", accountKey: "account", scope: ["write"],
    summary: "write", status: "approved", createdAt: "x", intentVersion: "approved-intent",
  });
  saved.set("resume-button", {
    localProductId: "resume-button",
    run: { id: "run", status: "paused", createdAt: "x", updatedAt: "x", intentVersion: "approved-intent" },
    events: [{
      id: "approval-event", runId: "run", type: "approval", content: "用户已授权", createdAt: "x",
      data: { approval: { id: "approval", productVersion: "old-version", accountKey: "account", scope: ["write"], summary: "write", status: "approved", createdAt: "x", intentVersion: "approved-intent" } },
    }],
  });

  await core.resume("resume-button");
  await core.idle("resume-button");

  const done = await core.get("resume-button");
  assert.equal(writes, 1);
  assert.equal(done.events.find((event) => event.type === "approval")?.data?.recoveredApproval, true);
});

test("recovery-only send carries an equivalent approval into a new run", async () => {
  const { core, saved, deps } = harness([
    { toolCalls: [{ id: "write-new-run", name: "write", arguments: {} }] },
    { content: "done" },
  ]);
  let writes = 0;
  deps.tools = [{ name: "write", description: "write", parameters: {}, write: true, approvalScope: ["write"],
    execute: async () => { writes += 1; return { content: "written" }; } }];
  deps.recoverApproval = async () => ({ id: "approval", productVersion: "version", accountKey: "account", scope: ["write"],
    summary: "write", status: "approved", createdAt: "x", intentVersion: "approved-intent" });
  saved.set("completed-recovery", {
    localProductId: "completed-recovery",
    run: { id: "old-run", status: "completed", createdAt: "x", updatedAt: "x", intentVersion: "approved-intent" },
    events: [{ id: "old-approval", runId: "old-run", type: "approval", content: "用户已授权", createdAt: "x",
      data: { approval: { id: "approval", productVersion: "old-version", accountKey: "account", scope: ["write"], summary: "write", status: "approved", createdAt: "x", intentVersion: "approved-intent" } } }],
  });

  const started = await core.send("completed-recovery", "继续");
  assert.notEqual(started.run?.id, "old-run");
  await core.idle("completed-recovery");
  const done = await core.get("completed-recovery");
  assert.equal(writes, 1);
  assert.ok(done.events.some((event) => event.runId === done.run?.id && event.type === "approval"
    && event.data?.recoveredApproval === true));
});

test("final VBK approval hands off to the deterministic workflow without another model turn", async () => {
  const { core, saved, deps } = harness([]);
  let modelCalls = 0;
  let handoffs = 0;
  deps.model = { complete: async () => { modelCalls += 1; return { content: "must not run" }; } };
  deps.handoffApprovedWorkflow = () => { handoffs += 1; return true; };
  saved.set("handoff", {
    localProductId: "handoff",
    run: { id: "run", status: "waiting_approval", createdAt: "x", updatedAt: "x", intentVersion: "intent" },
    pendingApproval: {
      id: "approval", productVersion: "version", accountKey: "account", intentVersion: "intent",
      scope: ["vbk.write_phase:basic", "vbk.write_phase:preflight"], summary: "录入", status: "pending", createdAt: "x",
    },
    events: [],
  });

  const accepted = await core.approve("handoff", { approvalId: "approval", productVersion: "version" });
  await core.idle("handoff");
  assert.equal(accepted.run?.status, "running");
  assert.equal(handoffs, 1);
  assert.equal(modelCalls, 0);

  // The renderer polls immediately after the confirmation click. That read
  // must not pause the detached deterministic runner before saleControl starts.
  assert.equal((await core.get("handoff")).run?.status, "running");
  assert.equal(handoffs, 1);

  const done = await core.completeApprovedWorkflow("handoff", "approval");
  assert.equal(done.run?.status, "completed");
});

test("completeApprovedWorkflow refuses unexplained fingerprint drift", async () => {
  const { core, saved, deps } = harness([]);
  deps.accountFor = async () => ({ accountKey: "account", productVersion: "post-automation-version" });
  saved.set("handoff-drift", {
    localProductId: "handoff-drift",
    run: { id: "run", status: "running", createdAt: "x", updatedAt: "x", intentVersion: "intent" },
    events: [{
      id: "approval-event", runId: "run", type: "approval", content: "用户已授权", createdAt: "x",
      data: {
        approval: {
          id: "approval", productVersion: "pre-write-version", accountKey: "account", intentVersion: "intent",
          scope: ["vbk.write_phase:basic"], summary: "录入", status: "approved", createdAt: "x",
        },
      },
    }],
  });

  const done = await core.completeApprovedWorkflow("handoff-drift", "approval");
  assert.equal(done.run?.status, "paused");
  const approval = done.events.find((event) => event.type === "approval")?.data?.approval as { productVersion?: string } | undefined;
  assert.equal(approval?.productVersion, "pre-write-version");
});

test("completeApprovedWorkflow uses the shared finish gate for deterministic handoff", async () => {
  const { core, saved, deps } = harness([]);
  let gateCalls = 0;
  deps.finishVerified = async (_id, context) => {
    gateCalls += 1;
    assert.equal(context?.deterministicWorkflow, true);
    assert.equal(context?.hadRemoteWrites, true);
    return { verified: true };
  };
  saved.set("handoff-gate", {
    localProductId: "handoff-gate",
    run: { id: "run", status: "running", createdAt: "x", updatedAt: "x", intentVersion: "intent" },
    events: [{
      id: "approval-event", runId: "run", type: "approval", content: "用户已授权", createdAt: "x",
      data: {
        approval: {
          id: "approval", productVersion: "version", accountKey: "account", intentVersion: "intent",
          scope: ["vbk.write_phase:basic"], summary: "录入", status: "approved", createdAt: "x",
        },
      },
    }],
  });

  const done = await core.completeApprovedWorkflow("handoff-gate", "approval");
  assert.equal(gateCalls, 1);
  assert.equal(done.run?.status, "completed");
});
