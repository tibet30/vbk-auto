import assert from "node:assert/strict";
import test from "node:test";
import { AgentCore } from "../../src/main/agent/core.js";
import { agentWorkflowPatch } from "../../src/main/agent/integration-workflow.js";
import {
  PRE_DISPATCH_VBK_IDENTITY_ERROR,
  SAFE_STARTUP_EXTERNAL_ACTION_BLOCK_REASON,
} from "../../src/main/agent/safe-startup-agent-guard.js";
import type { AgentCoreDependencies } from "../../src/main/agent/types.js";
import type { AgentApproval, AgentSnapshot } from "../../src/shared/contracts.js";

function failedSnapshot(options: {
  error?: string;
  uncertainWrite?: boolean;
  dispatched?: boolean;
  remoteWrite?: boolean;
} = {}): AgentSnapshot {
  const run = {
    id: "failed-run",
    status: "failed" as const,
    error: options.error ?? PRE_DISPATCH_VBK_IDENTITY_ERROR,
    intentVersion: "failed-intent",
    createdAt: "2026-10-14T05:32:40.459Z",
    updatedAt: "2026-10-14T05:32:43.848Z",
  };
  return {
    localProductId: "product",
    run,
    events: [
      {
        id: "continue-call",
        runId: run.id,
        type: "tool_call",
        content: "continue_approved_workflow",
        createdAt: run.createdAt,
        data: { toolCallId: "continue", name: "continue_approved_workflow", arguments: {} },
      },
      ...(options.dispatched ? [{
        id: "dispatch",
        runId: run.id,
        type: "status" as const,
        content: "已提交外部操作：continue_approved_workflow",
        createdAt: run.updatedAt,
        data: { writeDispatch: true, toolCallId: "continue" },
      }] : []),
      ...(options.remoteWrite ? [{
        id: "remote-result",
        runId: run.id,
        type: "tool_result" as const,
        content: "远端写入完成",
        createdAt: run.updatedAt,
        data: { toolCallId: "continue", write: true, remoteWrite: true },
      }] : []),
    ],
    ...(options.uncertainWrite ? {
      uncertainWrite: { toolCallId: "continue", message: "结果不明", createdAt: run.updatedAt },
    } : {}),
  };
}

function approvalSnapshot(pending: boolean): AgentSnapshot {
  const run: NonNullable<AgentSnapshot["run"]> = {
    id: "approval-run", status: pending ? "waiting_approval" : "paused", intentVersion: "approval-intent",
    createdAt: "2026-10-14T05:32:40.459Z", updatedAt: "2026-10-14T05:32:43.848Z",
  };
  const approval: AgentApproval = {
    id: "approval", status: pending ? "pending" : "approved", accountKey: "account", productVersion: "version",
    intentVersion: run.intentVersion, summary: "录入基础信息", scope: ["vbk.write_phase:basic"], createdAt: run.createdAt,
  };
  return {
    localProductId: "product", run, ...(pending ? { pendingApproval: approval } : {}),
    events: [{
      id: "approval-event", runId: run.id, type: pending ? "approval_request" : "approval",
      content: approval.summary, createdAt: run.createdAt, data: { approval },
    }],
  };
}

function recoveryHarness(initial: AgentSnapshot, options: { enabled: boolean; locallyReady: boolean }) {
  let saved = structuredClone(initial);
  let modelCalls = 0;
  let handoffs = 0;
  const deps: AgentCoreDependencies = {
    externalAgentActionsEnabled: options.enabled,
    safeStartupLocalPreparationReady: () => options.locallyReady,
    model: { complete: async () => { modelCalls += 1; return { content: "must not run" }; } },
    tools: [],
    accountFor: async () => ({ accountKey: "account", productVersion: "version" }),
    handoffApprovedWorkflow: () => { handoffs += 1; return true; },
  };
  const core = new AgentCore(deps, {
    getAgentSnapshot: () => structuredClone(saved),
    saveAgentSnapshot: (next) => { saved = structuredClone(next); },
  });
  return { core, saved: () => saved, modelCalls: () => modelCalls, handoffs: () => handoffs };
}

test("安全启动仅恢复无派发的身份失败，并投影为可继续处理", async () => {
  const initial = failedSnapshot();
  initial.events.unshift({
    id: "old-approval",
    runId: "old-run",
    type: "approval",
    content: "旧授权",
    createdAt: "2026-10-14T04:00:00.000Z",
    data: { approval: { id: "old", status: "approved" } },
  });
  const harness = recoveryHarness(initial, { enabled: false, locallyReady: true });

  const recovered = await harness.core.get("product");
  await harness.core.idle("product");

  assert.equal(recovered.run?.status, "paused");
  assert.equal(recovered.run?.error, undefined);
  assert.equal(recovered.pendingApproval, undefined);
  assert.equal(harness.saved().run?.status, "paused");
  assert.equal(harness.modelCalls(), 0);
  assert.equal(harness.handoffs(), 0);
  assert.equal(recovered.events.some((event) => event.data?.writeDispatch === true), false);
  assert.equal(recovered.events.some((event) => event.data?.remoteWrite === true), false);
  assert.ok(recovered.events.some((event) => event.runId === recovered.run?.id
    && event.data?.safeStartupIdentityRecovery === true
    && event.content === SAFE_STARTUP_EXTERNAL_ACTION_BLOCK_REASON));
  assert.equal((recovered.events[0]!.data?.approval as { status?: string }).status, "invalidated");
  const taskPatch = agentWorkflowPatch(harness.saved());
  assert.equal(taskPatch.status, "needs_attention");
  assert.equal(taskPatch.message, SAFE_STARTUP_EXTERNAL_ACTION_BLOCK_REASON);
  assert.equal(taskPatch.error, undefined);
});

test("恢复不放宽安全条件，也不把普通登录失败改写为暂停", async () => {
  const cases = [
    { name: "普通模式", options: { enabled: true, locallyReady: true }, snapshot: failedSnapshot() },
    { name: "本地尚未就绪", options: { enabled: false, locallyReady: false }, snapshot: failedSnapshot() },
    { name: "非精确错误", options: { enabled: false, locallyReady: true }, snapshot: failedSnapshot({ error: "当前 VBK 账号与产品绑定账号不一致，不能授权或写入。" }) },
    { name: "不确定写入", options: { enabled: false, locallyReady: true }, snapshot: failedSnapshot({ uncertainWrite: true }) },
    { name: "已派发写入", options: { enabled: false, locallyReady: true }, snapshot: failedSnapshot({ dispatched: true }) },
    { name: "已有远端写入证据", options: { enabled: false, locallyReady: true }, snapshot: failedSnapshot({ remoteWrite: true }) },
  ];
  for (const item of cases) {
    const harness = recoveryHarness(item.snapshot, item.options);
    const current = await harness.core.get("product");
    if (item.name === "已派发写入") {
      assert.equal(current.run?.status, "paused", item.name);
      assert.ok(current.uncertainWrite, item.name);
    } else assert.equal(current.run?.status, "failed", item.name);
    assert.equal(current.run?.error, item.snapshot.run?.error, item.name);
    assert.equal(current.events.some((event) => event.data?.safeStartupIdentityRecovery === true), false, item.name);
    assert.equal(harness.modelCalls(), 0, item.name);
    assert.equal(harness.handoffs(), 0, item.name);
  }
});

test("安全启动暂停直接授权，不探测账号或授予外部权限", async () => {
  let accountChecks = 0;
  let snapshot = approvalSnapshot(true);
  const core = new AgentCore({
    externalAgentActionsEnabled: false, tools: [],
    accountFor: async () => { accountChecks += 1; return { accountKey: "account", productVersion: "version" }; },
  }, {
    getAgentSnapshot: () => structuredClone(snapshot), saveAgentSnapshot: next => { snapshot = structuredClone(next); },
  });

  const result = await core.approve("product", { approvalId: "approval", productVersion: "version" });

  assert.equal(result.run?.status, "paused");
  assert.equal(result.pendingApproval?.status, "pending");
  assert.equal(accountChecks, 0);
  assert.ok(result.events.some(event => event.data?.safeStartupExternalActionBlocked === true));
  assert.equal(agentWorkflowPatch(result).message, SAFE_STARTUP_EXTERNAL_ACTION_BLOCK_REASON);
});

test("安全启动暂停已有确定性授权的恢复，但本地恢复仍可继续", async () => {
  let accountChecks = 0;
  let handoffs = 0;
  let modelCalls = 0;
  let snapshot = approvalSnapshot(false);
  const core = new AgentCore({
    externalAgentActionsEnabled: false, tools: [],
    model: { complete: async () => { modelCalls += 1; return { content: "不应执行" }; } },
    accountFor: async () => { accountChecks += 1; return { accountKey: "account", productVersion: "version" }; },
    handoffApprovedWorkflow: () => { handoffs += 1; return true; },
  }, {
    getAgentSnapshot: () => structuredClone(snapshot), saveAgentSnapshot: next => { snapshot = structuredClone(next); },
  });

  const result = await core.resume("product");
  await core.idle("product");

  assert.equal(result.run?.status, "paused");
  assert.equal(accountChecks, 0);
  assert.equal(handoffs, 0);
  assert.equal(modelCalls, 0);
  assert.ok(result.events.some(event => event.data?.safeStartupExternalActionBlocked === true));

  let localSnapshot: AgentSnapshot = { localProductId: "local", run: {
    id: "local-run", status: "paused", intentVersion: "local-intent", createdAt: "now", updatedAt: "now",
  }, events: [] };
  const local = new AgentCore({
    externalAgentActionsEnabled: false, tools: [],
    model: { complete: async () => ({ content: "本地恢复完成" }) },
    accountFor: async () => { throw new Error("本地恢复不应探测账号"); },
  }, {
    getAgentSnapshot: () => structuredClone(localSnapshot), saveAgentSnapshot: next => { localSnapshot = structuredClone(next); },
  });
  await local.resume("local");
  await local.idle("local");
  assert.equal(localSnapshot.run?.status, "completed");
});

test("安全启动阻断手动创建交通子产品，不读取产品或探测账号", async () => {
  let accountChecks = 0;
  let productReads = 0;
  const core = new AgentCore({
    externalAgentActionsEnabled: false, tools: [],
    preparationProduct: () => { productReads += 1; return undefined; },
    accountFor: async () => { accountChecks += 1; return { accountKey: "account", productVersion: "version" }; },
  }, { getAgentSnapshot: () => undefined, saveAgentSnapshot: () => {} });

  await assert.rejects(core.createTrafficChildren("product", false), error =>
    error instanceof Error && error.message === SAFE_STARTUP_EXTERNAL_ACTION_BLOCK_REASON);
  assert.equal(productReads, 0);
  assert.equal(accountChecks, 0);
});

test("安全启动在无工具最终审批边界暂停，不探测账号或创建审批", async () => {
  let accountChecks = 0;
  let snapshot: AgentSnapshot | undefined;
  const core = new AgentCore({
    externalAgentActionsEnabled: false,
    model: { complete: async () => ({ content: "本地准备已完成" }) },
    tools: [],
    accountFor: async () => { accountChecks += 1; return { accountKey: "account", productVersion: "version" }; },
    requiresCompletionVerification: () => true,
    finishVerified: async () => ({ verified: false, finalApproval: {
      scope: ["vbk.write_phase:basic"], summary: "录入基础信息",
    } }),
  }, {
    getAgentSnapshot: () => structuredClone(snapshot),
    saveAgentSnapshot: (next) => { snapshot = structuredClone(next); },
  });

  await core.send("product", "完成本地准备");
  await core.idle("product");

  assert.equal(snapshot?.run?.status, "paused");
  assert.equal(snapshot?.run?.error, undefined);
  assert.equal(snapshot?.pendingApproval, undefined);
  assert.equal(accountChecks, 0);
  assert.ok(snapshot?.events.some(event => event.data?.safeStartupExternalActionBlocked === true
    && event.content === SAFE_STARTUP_EXTERNAL_ACTION_BLOCK_REASON));
  assert.equal(agentWorkflowPatch(snapshot!).message, SAFE_STARTUP_EXTERNAL_ACTION_BLOCK_REASON);
});

test("安全启动在外部工具与审批边界暂停，不触发账号探测、派发或自动化", async () => {
  for (const call of [
    { id: "continue", name: "continue_approved_workflow", arguments: {} },
    { id: "approval", name: "request_approval", arguments: { scope: ["vbk.write_phase:basic"], summary: "录入" } },
  ]) {
    let accountChecks = 0;
    let automationStarts = 0;
    let snapshot: AgentSnapshot | undefined;
    const core = new AgentCore({
      externalAgentActionsEnabled: false,
      model: { complete: async () => ({ toolCalls: [call] }) },
      tools: [{ name: "continue_approved_workflow", requiresApproval: true, description: "continue", parameters: {},
        execute: async () => { automationStarts += 1; return { content: "started" }; } }],
      accountFor: async () => { accountChecks += 1; return { accountKey: "account", productVersion: "version" }; },
    }, {
      getAgentSnapshot: () => structuredClone(snapshot),
      saveAgentSnapshot: (next) => { snapshot = structuredClone(next); },
    });

    await core.send("product", "继续当前工作");
    await core.idle("product");

    assert.equal(snapshot?.run?.status, "paused", call.name);
    assert.equal(snapshot?.run?.error, undefined, call.name);
    assert.equal(snapshot?.pendingApproval, undefined, call.name);
    assert.equal(accountChecks, 0, call.name);
    assert.equal(automationStarts, 0, call.name);
    assert.equal(snapshot?.events.some((event) => event.data?.writeDispatch === true), false, call.name);
    assert.equal(snapshot?.events.some((event) => event.data?.remoteWrite === true), false, call.name);
    assert.ok(snapshot?.events.some((event) => event.data?.safeStartupExternalActionBlocked === true
      && event.content === SAFE_STARTUP_EXTERNAL_ACTION_BLOCK_REASON), call.name);
  }
});

test("安全启动仍允许纯本地 Agent 工具", async () => {
  let localWrites = 0;
  let snapshot: AgentSnapshot | undefined;
  const core = new AgentCore({
    externalAgentActionsEnabled: false,
    model: { complete: async () => ({ toolCalls: [{ id: "local", name: "patch_local", arguments: {} }] }) },
    tools: [{ name: "patch_local", write: true, requiresApproval: false, description: "local", parameters: {},
      execute: async () => { localWrites += 1; return { content: "已保存本地方案", terminal: true }; } }],
    accountFor: async () => { throw new Error("本地工具不应探测账号"); },
  }, {
    getAgentSnapshot: () => structuredClone(snapshot),
    saveAgentSnapshot: (next) => { snapshot = structuredClone(next); },
  });

  await core.send("product", "仅修改本地行程");
  await core.idle("product");

  assert.equal(localWrites, 1);
  assert.equal(snapshot?.run?.status, "completed");
  assert.equal(snapshot?.events.some((event) => event.data?.safeStartupExternalActionBlocked === true), false);
});
