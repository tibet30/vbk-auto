import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VbkDatabase } from "../../src/main/infrastructure/database/database.js";
import { createAgentRuntime } from "../../src/main/agent-runtime/index.js";
import type { AgentModel, AgentModelInput, AgentModelResult } from "../../src/main/agent/types.js";

const OWNER = 1001;

class ScriptedModel implements AgentModel {
  constructor(private readonly responses: AgentModelResult[]) {}

  async complete(_input: AgentModelInput): Promise<AgentModelResult> {
    const next = this.responses.shift();
    if (!next) throw new Error("模型脚本已用尽");
    return next;
  }
}

function seed(): { dir: string; db: VbkDatabase; threadId: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vbk-transcript-"));
  const db = new VbkDatabase(path.join(dir, ".data"));
  const thread = db.createAgentThread(OWNER, { workingDirectory: dir, title: "transcript" });
  return { dir, db, threadId: thread.id };
}

function common(db: VbkDatabase, threadId: string, dir: string, model: AgentModel) {
  return {
    ownerUserId: OWNER,
    threadId,
    history: [{ role: "user" as const, content: "整理目录" }],
    workingDirectory: dir,
    provider: async () => ({ model, systemPrompt: "系统说明" }),
  };
}

test("运行结束后释放 transcript：审计仍由动作与收据承担", async () => {
  const { dir, db, threadId } = seed();
  const runtime = createAgentRuntime(db);
  const model = new ScriptedModel([
    { toolCalls: [{ id: "call-1", name: "file.list", arguments: {} }] },
    { content: "目录已看完。" },
  ]);
  const run = await runtime.runs.start({ ...common(db, threadId, dir, model), intent: "整理目录" });
  assert.equal(run.status, "completed");
  assert.deepEqual(db.getAgentRunTranscript(OWNER, run.id), [], "终态不应保留中间 transcript");
  assert.equal(db.listAgentToolCalls(OWNER, run.id).length, 1, "动作记录仍在");
  assert.equal(db.listAgentActionReceipts(OWNER, threadId).length, 1, "收据仍在");
});

test("被拒绝或取消的运行同样释放 transcript", async () => {
  const rejectedDir = seed();
  const rejectedRuntime = createAgentRuntime(rejectedDir.db);
  const waitingModel = new ScriptedModel([
    { toolCalls: [{ id: "call-1", name: "file.create", arguments: { path: "a.md", content: "A" } }] },
  ]);
  await rejectedRuntime.runs.start({
    ...common(rejectedDir.db, rejectedDir.threadId, rejectedDir.dir, waitingModel),
    intent: "写文件",
  });
  const approval = rejectedRuntime.runs.snapshot({
    ownerUserId: OWNER, threadId: rejectedDir.threadId, workingDirectory: rejectedDir.dir,
  }).approval!;
  assert.ok(rejectedDir.db.getAgentRun(OWNER, approval.runId));
  const rejected = await rejectedRuntime.runs.reject({
    ownerUserId: OWNER,
    threadId: rejectedDir.threadId,
    toolCallId: approval.toolCallId,
    reason: "先不写",
    workingDirectory: rejectedDir.dir,
  });
  assert.equal(rejected.status, "rejected");
  assert.deepEqual(rejectedDir.db.getAgentRunTranscript(OWNER, rejected.id), []);

  const cancelledDir = seed();
  const cancelledRuntime = createAgentRuntime(cancelledDir.db);
  const run = cancelledDir.db.createAgentRun(OWNER, { threadId: cancelledDir.threadId, intent: "写文件" });
  cancelledDir.db.saveAgentRunTranscript(OWNER, run.id, [{ role: "assistant", content: "x" }]);
  await cancelledRuntime.runs.cancel({ ownerUserId: OWNER, threadId: cancelledDir.threadId });
  assert.deepEqual(cancelledDir.db.getAgentRunTranscript(OWNER, run.id), []);
});

test("等待审批的运行保留 transcript，供恢复后继续", async () => {
  const { dir, db, threadId } = seed();
  const runtime = createAgentRuntime(db);
  const model = new ScriptedModel([
    { toolCalls: [{ id: "call-1", name: "file.create", arguments: { path: "b.md", content: "B" } }] },
  ]);
  const run = await runtime.runs.start({ ...common(db, threadId, dir, model), intent: "写文件" });
  assert.equal(run.status, "waiting_approval");
  assert.ok(db.getAgentRunTranscript(OWNER, run.id).length > 0, "待审批必须保留工具往返");

});
