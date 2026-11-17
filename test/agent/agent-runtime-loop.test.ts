import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VbkDatabase } from "../../src/main/infrastructure/database/database.js";
import { createAgentRuntime } from "../../src/main/agent-runtime/index.js";
import type { AgentModel, AgentModelInput, AgentModelResult } from "../../src/main/agent/types.js";

const OWNER = 1001;

/** 按脚本回放的模型：用于验证运行协议，不触网。 */
class ScriptedModel implements AgentModel {
  readonly inputs: AgentModelInput[] = [];
  constructor(private readonly responses: AgentModelResult[]) {}

  async complete(input: AgentModelInput): Promise<AgentModelResult> {
    this.inputs.push(input);
    const next = this.responses.shift();
    if (!next) throw new Error("模型脚本已用尽");
    return next;
  }
}

function workspace(): { dir: string; db: VbkDatabase; threadId: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vbk-agent-runtime-"));
  const db = new VbkDatabase(path.join(dir, "data"));
  const thread = db.createAgentThread(OWNER, { workingDirectory: dir, title: "整理文件" });
  db.addAgentThreadMessage(OWNER, thread.id, "user", "把备注整理成新文件");
  return { dir, db, threadId: thread.id };
}

const createCall = (id: string, file: string, content: string): AgentModelResult => ({
  toolCalls: [{ id, name: "file.create", arguments: { path: file, content } }],
});

test("计划 → 请求授权 → 授权 → 执行 → 收据 → 恢复对话", async () => {
  const { dir, db, threadId } = workspace();
  const runtime = createAgentRuntime(db);
  const model = new ScriptedModel([createCall("call-1", "out.md", "新内容"), { content: "已新建 out.md。" }]);
  const common = {
    ownerUserId: OWNER,
    threadId,
    history: [{ role: "user" as const, content: "把备注整理成新文件" }],
    workingDirectory: dir,
    provider: async () => ({ model, systemPrompt: "系统说明" }),
  };

  const waiting = await runtime.runs.start({ ...common, intent: "把备注整理成新文件" });
  assert.equal(waiting.status, "waiting_approval");
  assert.equal(fs.existsSync(path.join(dir, "out.md")), false, "批准前不允许发生写入");

  const pending = runtime.runs.snapshot({ ownerUserId: OWNER, threadId, workingDirectory: dir });
  assert.ok(pending.approval, "面板必须能拿到审批请求");
  assert.equal(pending.approval.kind, "write");
  assert.equal(pending.approval.actionLabel, "新建文件");
  assert.match(pending.approval.targetKey, /out\.md$/u);
  assert.match(pending.approval.diff ?? "", /\+ 新内容/u);
  assert.deepEqual(pending.toolCalls.map((call) => call.status), ["awaiting_approval"]);
  assert.equal(pending.receipts.length, 0, "未执行前不得有收据");

  const done = await runtime.runs.approve({ ...common, toolCallId: pending.approval.toolCallId, scope: "once" });
  assert.equal(done.status, "completed");
  assert.equal(fs.readFileSync(path.join(dir, "out.md"), "utf8"), "新内容");

  const receipts = db.listAgentActionReceipts(OWNER, threadId);
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].status, "succeeded");
  assert.equal(receipts[0].action, "file.create");

  const messages = db.getAgentThreadDetail(OWNER, threadId).messages;
  assert.equal(messages[messages.length - 1].role, "assistant");
  assert.equal(messages[messages.length - 1].content, "已新建 out.md。");
  assert.equal(runtime.runs.snapshot({ ownerUserId: OWNER, threadId, workingDirectory: dir }).approval, undefined);
});

test("重复批准同一动作不会重复写入，也不会产生第二张收据", async () => {
  const { dir, db, threadId } = workspace();
  const runtime = createAgentRuntime(db);
  const model = new ScriptedModel([createCall("call-1", "once.md", "只写一次"), { content: "完成。" }]);
  const common = {
    ownerUserId: OWNER,
    threadId,
    history: [{ role: "user" as const, content: "写一次" }],
    workingDirectory: dir,
    provider: async () => ({ model, systemPrompt: "系统说明" }),
  };
  await runtime.runs.start({ ...common, intent: "写一次" });
  const approval = runtime.runs.snapshot({ ownerUserId: OWNER, threadId, workingDirectory: dir }).approval!;
  await runtime.runs.approve({ ...common, toolCallId: approval.toolCallId, scope: "once" });

  await assert.rejects(
    () => runtime.runs.approve({ ...common, toolCallId: approval.toolCallId, scope: "once" }),
    /已经处理过/u,
  );
  assert.equal(db.listAgentActionReceipts(OWNER, threadId).length, 1);
});

test("本任务内授权覆盖后续同类写入，不再弹审批", async () => {
  const { dir, db, threadId } = workspace();
  const runtime = createAgentRuntime(db);
  const history = [{ role: "user" as const, content: "生成两个文件" }];
  const firstModel = new ScriptedModel([createCall("call-a", "a.md", "A"), { content: "已建 a.md。" }]);
  const first = await runtime.runs.start({
    ownerUserId: OWNER,
    threadId,
    history,
    workingDirectory: dir,
    intent: "生成两个文件",
    provider: async () => ({ model: firstModel, systemPrompt: "系统说明" }),
  });
  assert.equal(first.status, "waiting_approval");
  const approval = runtime.runs.snapshot({ ownerUserId: OWNER, threadId, workingDirectory: dir }).approval!;
  const afterFirst = await runtime.runs.approve({
    ownerUserId: OWNER,
    threadId,
    history,
    workingDirectory: dir,
    toolCallId: approval.toolCallId,
    scope: "thread",
    provider: async () => ({ model: firstModel, systemPrompt: "系统说明" }),
  });
  assert.equal(afterFirst.status, "completed");

  const secondModel = new ScriptedModel([createCall("call-b", "b.md", "B"), { content: "已建 b.md。" }]);
  const second = await runtime.runs.start({
    ownerUserId: OWNER,
    threadId,
    history,
    workingDirectory: dir,
    intent: "再生成一个",
    provider: async () => ({ model: secondModel, systemPrompt: "系统说明" }),
  });
  assert.equal(second.status, "completed", "已授权目录内的同类写入不应再次暂停");
  assert.equal(fs.readFileSync(path.join(dir, "b.md"), "utf8"), "B");
  assert.equal(db.listAgentActionReceipts(OWNER, threadId).length, 2);
});

test("拒绝后运行为 rejected，动作未执行且无成功收据", async () => {
  const { dir, db, threadId } = workspace();
  const runtime = createAgentRuntime(db);
  const model = new ScriptedModel([createCall("call-1", "blocked.md", "不该写入")]);
  await runtime.runs.start({
    ownerUserId: OWNER,
    threadId,
    history: [{ role: "user" as const, content: "写文件" }],
    workingDirectory: dir,
    intent: "写文件",
    provider: async () => ({ model, systemPrompt: "系统说明" }),
  });
  const approval = runtime.runs.snapshot({ ownerUserId: OWNER, threadId, workingDirectory: dir }).approval!;
  const rejected = await runtime.runs.reject({
    ownerUserId: OWNER,
    threadId,
    toolCallId: approval.toolCallId,
    reason: "先不要写",
    workingDirectory: dir,
  });
  assert.equal(rejected.status, "rejected");
  assert.equal(fs.existsSync(path.join(dir, "blocked.md")), false);
  assert.equal(db.listAgentActionReceipts(OWNER, threadId).length, 0);
  const snapshot = runtime.runs.snapshot({ ownerUserId: OWNER, threadId, workingDirectory: dir });
  assert.equal(snapshot.toolCalls[0].status, "denied");
  assert.ok(db.getAgentThreadDetail(OWNER, threadId).messages.some((message) => message.role === "system"));
});

test("重启后待审批动作仍可恢复，中断的执行转 uncertain", async () => {
  const { dir, db, threadId } = workspace();
  const first = createAgentRuntime(db);
  const model = new ScriptedModel([createCall("call-1", "pending.md", "等授权")]);
  await first.runs.start({
    ownerUserId: OWNER,
    threadId,
    history: [{ role: "user" as const, content: "写文件" }],
    workingDirectory: dir,
    intent: "写文件",
    provider: async () => ({ model, systemPrompt: "系统说明" }),
  });

  // 模拟应用重启：新的运行时实例只依赖 SQLite。
  const restarted = createAgentRuntime(db);
  const restored = restarted.runs.snapshot({ ownerUserId: OWNER, threadId, workingDirectory: dir });
  assert.equal(restored.run?.status, "waiting_approval");
  assert.ok(restored.approval, "重启后审批请求必须仍然存在");

  // 模拟执行中途崩溃：运行回到 running、动作停在 executing。
  db.updateAgentRun(OWNER, restored.run!.id, { status: "running" });
  db.updateAgentToolCall(OWNER, restored.approval!.toolCallId, { status: "executing" });
  const recovery = restarted.runs.recoverInterrupted();
  assert.equal(recovery.runs, 1);
  assert.equal(recovery.toolCalls, 1);
  const after = restarted.runs.snapshot({ ownerUserId: OWNER, threadId, workingDirectory: dir });
  assert.equal(after.run?.status, "needs_attention");
  assert.equal(after.toolCalls[0].status, "uncertain");
  assert.equal(after.receipts.length, 0);
});
