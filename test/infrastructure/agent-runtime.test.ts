import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VbkDatabase } from "../../src/main/infrastructure/database/database.js";

const OWNER = 1001;

function seeded(): { db: VbkDatabase; threadId: string; runId: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vbk-agent-runtime-db-"));
  const db = new VbkDatabase(path.join(dir, "data"));
  const thread = db.createAgentThread(OWNER, { title: "运行事实" });
  const run = db.createAgentRun(OWNER, { threadId: thread.id, intent: "整理目录" });
  return { db, threadId: thread.id, runId: run.id };
}

test("运行、工具调用与 transcript 按用户隔离并可回读", () => {
  const { db, threadId, runId } = seeded();
  db.saveAgentRunTranscript(OWNER, runId, [{ role: "assistant", content: "准备写入" }]);
  db.updateAgentRun(OWNER, runId, { status: "waiting_approval", step: 2 });
  const call = db.insertAgentToolCall(OWNER, {
    runId,
    threadId,
    skillId: "local-file",
    toolName: "file.create",
    arguments: { path: "a.md", content: "A" },
    status: "awaiting_approval",
    kind: "write",
    risk: "medium",
    idempotencyKey: `${runId}:call-1`,
    accountKey: "local-fs",
    targetKey: "/tmp/root/a.md",
    summary: "新建文件 a.md",
  });

  const run = db.getAgentRun(OWNER, runId)!;
  assert.equal(run.status, "waiting_approval");
  assert.equal(run.step, 2);
  assert.equal(db.getAgentRunTranscript(OWNER, runId).length, 1);
  assert.equal(db.findActiveAgentRun(OWNER, threadId)?.id, runId);
  assert.equal(db.listAgentToolCalls(OWNER, runId)[0].id, call.id);
  assert.equal(db.getAgentToolCall(OWNER, call.id)?.targetKey, "/tmp/root/a.md");
  assert.equal(db.getAgentRun(1002, runId), undefined, "跨用户不可见");
});

test("幂等键唯一：重复插入同一动作不会产生第二条工具调用或第二张收据", () => {
  const { db, threadId, runId } = seeded();
  const input = {
    runId,
    threadId,
    skillId: "local-file",
    toolName: "file.create",
    arguments: { path: "a.md", content: "A" },
    status: "awaiting_approval" as const,
    kind: "write" as const,
    risk: "medium" as const,
    idempotencyKey: `dup-key`,
    summary: "新建文件 a.md",
  };
  const first = db.insertAgentToolCall(OWNER, input);
  assert.throws(() => db.insertAgentToolCall(OWNER, input), /UNIQUE|unique/u);
  assert.equal(db.findAgentToolCallByIdempotencyKey("dup-key")?.id, first.id);

  const receipt = db.saveAgentActionReceipt(OWNER, {
    threadId,
    runId,
    toolCallId: first.id,
    action: "file.create",
    targetKey: "/tmp/root/a.md",
    accountKey: "local-fs",
    idempotencyKey: "dup-key",
    status: "succeeded",
    result: "创建 a.md",
  });
  const again = db.saveAgentActionReceipt(OWNER, {
    threadId,
    runId,
    toolCallId: first.id,
    action: "file.create",
    targetKey: "/tmp/root/a.md",
    accountKey: "local-fs",
    idempotencyKey: "dup-key",
    status: "succeeded",
    result: "创建 a.md",
  });
  assert.equal(receipt.created, true);
  assert.equal(again.created, false);
  assert.equal(again.receipt.id, receipt.receipt.id);
  assert.equal(db.listAgentActionReceipts(OWNER, threadId).length, 1);
});

test("授权记录可撤销，不确定收据只能单向收敛", () => {
  const { db, threadId, runId } = seeded();
  const call = db.insertAgentToolCall(OWNER, {
    runId,
    threadId,
    skillId: "local-file",
    toolName: "file.delete",
    arguments: { path: "a.md" },
    status: "awaiting_approval",
    kind: "delete",
    risk: "high",
    idempotencyKey: `${runId}:call-del`,
    summary: "删除 a.md",
  });
  const grant = db.createAgentPermissionGrant(OWNER, {
    threadId,
    runId,
    toolCallId: call.id,
    scope: "thread",
    action: "file.delete",
    targetKey: "/tmp/root",
    accountKey: "local-fs",
  });
  assert.equal(db.listAgentPermissionGrants(OWNER, threadId).length, 1);
  assert.equal(db.revokeAgentPermissionGrants(OWNER, threadId, "working_directory_changed"), 1);
  const revoked = db.listAgentPermissionGrants(OWNER, threadId)[0];
  assert.equal(revoked.id, grant.id);
  assert.equal(revoked.revokedReason, "working_directory_changed");
  assert.ok(revoked.revokedAt);

  const uncertain = db.saveAgentActionReceipt(OWNER, {
    threadId,
    runId,
    toolCallId: call.id,
    action: "file.delete",
    targetKey: "/tmp/root/a.md",
    accountKey: "local-fs",
    idempotencyKey: `${runId}:call-del`,
    status: "uncertain",
    result: "写入结果未知",
  });
  const reconciled = db.markAgentActionReceiptReconciled(OWNER, uncertain.receipt.id, {
    status: "failed",
    detail: "核查：目标仍存在",
  });
  assert.equal(reconciled.status, "failed");
  assert.equal(reconciled.idempotencyKey, `${runId}:call-del`);
  const noop = db.markAgentActionReceiptReconciled(OWNER, uncertain.receipt.id, { status: "succeeded", detail: "重复收敛" });
  assert.equal(noop.status, "failed", "已收敛的收据不得翻转");
});

test("中断恢复只影响 executing 动作与 queued/running 运行", () => {
  const { db, threadId, runId } = seeded();
  const call = db.insertAgentToolCall(OWNER, {
    runId,
    threadId,
    skillId: "local-file",
    toolName: "file.move",
    arguments: { from: "a.md", to: "b.md" },
    status: "executing",
    kind: "write",
    risk: "medium",
    idempotencyKey: `${runId}:call-move`,
    summary: "移动 a.md",
  });
  const done = db.createAgentRun(OWNER, { threadId, intent: "已完成" });
  db.updateAgentRun(OWNER, done.id, { status: "completed", completedAt: new Date().toISOString() });

  assert.equal(db.markInterruptedAgentToolCallsUncertain("应用重启"), 1);
  assert.equal(db.getAgentToolCall(OWNER, call.id)?.status, "uncertain");
  assert.equal(db.recoverInterruptedAgentRuns("应用重启"), 1);
  assert.equal(db.getAgentRun(OWNER, runId)?.status, "needs_attention");
  assert.equal(db.getAgentRun(OWNER, done.id)?.status, "completed", "已完成的运行不受影响");
});

test("同毫秒写入按插入顺序返回，不依赖随机主键", () => {
  const { db, threadId, runId } = seeded();
  // 快速插入必然有多条落在同一毫秒：顺序必须以插入序（rowid）为准。
  for (let index = 0; index < 12; index += 1) {
    db.addAgentThreadMessage(OWNER, threadId, index % 2 ? "assistant" : "user", `第 ${index} 条`);
  }
  assert.deepEqual(
    db.listAgentThreadMessages(OWNER, threadId).map((message) => message.content),
    Array.from({ length: 12 }, (_, index) => `第 ${index} 条`),
  );

  const toolIds = Array.from({ length: 6 }, (_, index) => db.insertAgentToolCall(OWNER, {
    runId,
    threadId,
    skillId: "local-file",
    toolName: "file.read",
    arguments: {},
    status: "succeeded",
    kind: "read",
    risk: "low",
    idempotencyKey: `order-call-${index}`,
    summary: `动作 ${index}`,
  }).id);
  assert.deepEqual(db.listAgentToolCalls(OWNER, runId).map((call) => call.summary),
    Array.from({ length: 6 }, (_, index) => `动作 ${index}`));
  assert.deepEqual(db.listAgentToolCallsByThread(OWNER, threadId, 6).map((call) => call.summary),
    Array.from({ length: 6 }, (_, index) => `动作 ${index}`));

  for (let index = 0; index < 6; index += 1) {
    db.saveAgentActionReceipt(OWNER, {
      threadId,
      runId,
      toolCallId: toolIds[index],
      action: "file.read",
      targetKey: `/tmp/root/${index}`,
      accountKey: "local-fs",
      idempotencyKey: `order-call-${index}`,
      status: "succeeded",
      result: `结果 ${index}`,
    });
  }
  assert.deepEqual(db.listAgentActionReceipts(OWNER, threadId, 6).map((receipt) => receipt.result),
    Array.from({ length: 6 }, (_, index) => `结果 ${index}`));
});
