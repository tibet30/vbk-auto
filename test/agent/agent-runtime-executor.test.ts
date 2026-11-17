import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VbkDatabase } from "../../src/main/infrastructure/database/database.js";
import {
  AgentUncertainActionError,
  createAgentRuntime,
  evaluatePermission,
  type AgentSkill,
  type AgentSkillAction,
} from "../../src/main/agent-runtime/index.js";

const OWNER = 1001;

function seed(): { db: VbkDatabase; threadId: string; runId: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vbk-agent-executor-"));
  const db = new VbkDatabase(path.join(dir, "data"));
  const thread = db.createAgentThread(OWNER, { title: "执行器" });
  const run = db.createAgentRun(OWNER, { threadId: thread.id, intent: "测试" });
  return { db, threadId: thread.id, runId: run.id };
}

function countingSkill(options: { accountKey: string; delayMs: number }): {
  skill: AgentSkill;
  stats: { active: number; peak: number; runs: number };
} {
  const stats = { active: 0, peak: 0, runs: 0 };
  const toolName = `fake.write.${options.accountKey}`;
  const action: AgentSkillAction = {
    name: toolName,
    kind: "write",
    label: "测试写入",
    risk: "medium",
    description: "测试用写入",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    async target() {
      return { action: toolName, targetKey: "/virtual/target", accountKey: options.accountKey, risk: "medium" };
    },
    async execute() {
      stats.active += 1;
      stats.runs += 1;
      stats.peak = Math.max(stats.peak, stats.active);
      await new Promise((resolve) => setTimeout(resolve, options.delayMs));
      stats.active -= 1;
      return { content: "写入成功", summary: "测试写入成功", result: "ok" };
    },
  };
  return { skill: { id: `fake-${options.accountKey}`, label: "测试", description: "测试", actions: [action] }, stats };
}

function toolCall(
  db: VbkDatabase,
  owner: number,
  ids: { runId: string; threadId: string },
  key: string,
  toolName = "fake.write",
) {
  return db.insertAgentToolCall(owner, {
    runId: ids.runId,
    threadId: ids.threadId,
    skillId: "fake",
    toolName,
    arguments: {},
    status: "awaiting_approval",
    kind: "write",
    risk: "medium",
    idempotencyKey: key,
    summary: "测试写入",
  });
}

/** 写入结果不明、回读也可能失败的 Skill：用于验证 uncertain → 核查收敛。 */
function flakySkill(state: { landed: boolean; readbackFails: boolean }): AgentSkill {
  const action: AgentSkillAction = {
    name: "fake.flaky",
    kind: "write",
    label: "不确定写入",
    risk: "high",
    description: "测试用不确定写入",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    async target() {
      return { action: "fake.flaky", targetKey: "/virtual/flaky", accountKey: "flaky-account", risk: "high" };
    },
    async execute() {
      throw new AgentUncertainActionError("写入状态不明");
    },
    async reconcile() {
      if (state.readbackFails) throw new Error("回读超时");
      return { landed: state.landed, detail: state.landed ? "目标已按预期变更" : "目标未变更" };
    },
  };
  return { id: "flaky", label: "不确定写入", description: "测试", actions: [action] };
}

test("同一账号的写操作串行，不同账号可并行", async () => {
  const serial = countingSkill({ accountKey: "local-fs", delayMs: 20 });
  const parallel = countingSkill({ accountKey: "other-account", delayMs: 20 });
  const { db, threadId, runId } = seed();
  const runtime = createAgentRuntime(db, { skills: [serial.skill, parallel.skill] });
  const ids = { runId, threadId };
  const target = { action: "fake.write", targetKey: "/virtual/target", accountKey: "local-fs", risk: "medium" as const };
  const context = { ownerUserId: OWNER, threadId, runId };

  const a = toolCall(db, OWNER, ids, "key-a");
  const b = toolCall(db, OWNER, ids, "key-b");
  await Promise.all([
    runtime.executor.execute({ ownerUserId: OWNER, threadId, runId, action: serial.skill.actions[0], args: {}, target, context, toolCall: a }),
    runtime.executor.execute({ ownerUserId: OWNER, threadId, runId, action: serial.skill.actions[0], args: {}, target, context, toolCall: b }),
  ]);
  assert.equal(serial.stats.peak, 1, "同账号写操作必须串行");

  const crossA = toolCall(db, OWNER, ids, "key-c");
  const crossB = toolCall(db, OWNER, ids, "key-d");
  const other = { ...target, accountKey: "other-account" };
  await Promise.all([
    runtime.executor.execute({ ownerUserId: OWNER, threadId, runId, action: serial.skill.actions[0], args: {}, target, context, toolCall: crossA }),
    runtime.executor.execute({ ownerUserId: OWNER, threadId, runId, action: parallel.skill.actions[0], args: {}, target: other, context, toolCall: crossB }),
  ]);
  assert.equal(parallel.stats.peak, 1);
});

test("同一幂等键重复提交只产生一次写入与一张收据", async () => {
  const { skill, stats } = countingSkill({ accountKey: "local-fs", delayMs: 1 });
  const { db, threadId, runId } = seed();
  const runtime = createAgentRuntime(db, { skills: [skill] });
  const ids = { runId, threadId };
  const tool = toolCall(db, OWNER, ids, "idem-1");
  const target = { action: "fake.write", targetKey: "/virtual/target", accountKey: "local-fs", risk: "medium" as const };
  const context = { ownerUserId: OWNER, threadId, runId };

  const first = await runtime.executor.execute({ ownerUserId: OWNER, threadId, runId, action: skill.actions[0], args: {}, target, context, toolCall: tool });
  const second = await runtime.executor.execute({ ownerUserId: OWNER, threadId, runId, action: skill.actions[0], args: {}, target, context, toolCall: tool });

  assert.equal(stats.runs, 1, "重复提交不得触发第二次写入");
  assert.equal(first.deduplicated, false);
  assert.equal(second.deduplicated, true);
  assert.equal(second.receipt.id, first.receipt.id);
  assert.equal(db.listAgentActionReceipts(OWNER, threadId).length, 1);
});

test("权限策略：读取免审批，写入需授权，授权按作用域与撤销状态生效", () => {
  const target = { action: "file.write", targetKey: "/root/docs/a.md", accountKey: "local-fs", risk: "medium" as const };
  assert.equal(evaluatePermission({ kind: "read", target, grants: [], toolCallId: "tc-1" }).requiresApproval, false);

  const write = evaluatePermission({ kind: "write", target, grants: [], toolCallId: "tc-1" });
  assert.equal(write.requiresApproval, true);

  const onceGrant = {
    id: "g-1", threadId: "t", runId: "r", toolCallId: "tc-1", scope: "once" as const,
    action: "file.write", targetKey: target.targetKey, accountKey: "local-fs", grantedAt: "2026-01-01T00:00:00.000Z",
  };
  assert.equal(evaluatePermission({ kind: "write", target, grants: [onceGrant], toolCallId: "tc-1" }).requiresApproval, false);
  assert.equal(evaluatePermission({ kind: "write", target, grants: [onceGrant], toolCallId: "tc-2" }).requiresApproval, true,
    "一次授权不得覆盖其他动作");

  const threadGrant = { ...onceGrant, id: "g-2", scope: "thread" as const, targetKey: "/root/docs", toolCallId: "tc-3" };
  assert.equal(evaluatePermission({ kind: "write", target, grants: [threadGrant], toolCallId: "tc-4" }).requiresApproval, false);
  assert.equal(evaluatePermission({
    kind: "write",
    target: { ...target, targetKey: "/root/other/a.md" },
    grants: [threadGrant],
    toolCallId: "tc-5",
  }).requiresApproval, true, "目录范围外的写入仍需审批");
  assert.equal(evaluatePermission({
    kind: "delete",
    target,
    grants: [{ ...threadGrant, revokedAt: "2026-01-02T00:00:00.000Z" }],
    toolCallId: "tc-6",
  }).requiresApproval, true, "已撤销的授权不得继续生效");
});

test("回读失败时停在 uncertain，核查成功后才收敛为成功", async () => {
  const state = { landed: true, readbackFails: true };
  const { db, threadId, runId } = seed();
  const runtime = createAgentRuntime(db, { skills: [flakySkill(state)] });
  const tool = toolCall(db, OWNER, { runId, threadId }, "flaky-1", "fake.flaky");
  const target = { action: "fake.flaky", targetKey: "/virtual/flaky", accountKey: "flaky-account", risk: "high" as const };
  const context = { ownerUserId: OWNER, threadId, runId };

  const executed = await runtime.executor.execute({
    ownerUserId: OWNER, threadId, runId, action: flakySkill(state).actions[0], args: {}, target, context, toolCall: tool,
  });
  assert.equal(executed.receipt.status, "uncertain");
  assert.equal(db.getAgentToolCall(OWNER, tool.id)?.status, "uncertain");
  db.updateAgentRun(OWNER, runId, { status: "uncertain", error: "写入状态不明" });

  // 核查仍无法判定时保持 uncertain，不猜成功也不允许重试。
  await assert.rejects(
    () => runtime.runs.reconcile({ ownerUserId: OWNER, threadId, toolCallId: tool.id }),
    /回读超时/u,
  );
  assert.equal(db.getAgentToolCall(OWNER, tool.id)?.status, "uncertain");

  state.readbackFails = false;
  const reconciled = await runtime.runs.reconcile({ ownerUserId: OWNER, threadId, toolCallId: tool.id });
  assert.equal(reconciled.receipt.status, "succeeded");
  assert.equal(reconciled.toolCall.status, "succeeded");
  assert.equal(db.getAgentRun(OWNER, runId)?.status, "needs_attention", "核查后运行回到可继续状态");
  assert.ok(db.getAgentThreadDetail(OWNER, threadId).messages
    .some((message) => message.role === "system" && message.content.includes("核查确认已落地")));

  // 已收敛的动作不能再次核查翻转结论，也不能再产生第二张收据。
  await assert.rejects(
    () => runtime.runs.reconcile({ ownerUserId: OWNER, threadId, toolCallId: tool.id }),
    /不在待核查状态/u,
  );
  assert.equal(db.listAgentActionReceipts(OWNER, threadId).length, 1);
});

test("核查确认未落地时收据收敛为失败", async () => {
  const state = { landed: false, readbackFails: true };
  const { db, threadId, runId } = seed();
  const runtime = createAgentRuntime(db, { skills: [flakySkill(state)] });
  const tool = toolCall(db, OWNER, { runId, threadId }, "flaky-2", "fake.flaky");
  const target = { action: "fake.flaky", targetKey: "/virtual/flaky", accountKey: "flaky-account", risk: "high" as const };
  await runtime.executor.execute({
    ownerUserId: OWNER, threadId, runId, action: flakySkill(state).actions[0], args: {}, target,
    context: { ownerUserId: OWNER, threadId, runId }, toolCall: tool,
  });
  db.updateAgentRun(OWNER, runId, { status: "uncertain" });

  state.readbackFails = false;
  const reconciled = await runtime.runs.reconcile({ ownerUserId: OWNER, threadId, toolCallId: tool.id });
  assert.equal(reconciled.receipt.status, "failed");
  assert.equal(reconciled.toolCall.status, "failed");
  assert.ok(db.getAgentThreadDetail(OWNER, threadId).messages
    .some((message) => message.role === "system" && message.content.includes("核查确认未落地")));
});
