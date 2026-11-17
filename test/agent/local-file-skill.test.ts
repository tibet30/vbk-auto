import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VbkDatabase } from "../../src/main/infrastructure/database/database.js";
import { createAgentRuntime, evaluatePermission } from "../../src/main/agent-runtime/index.js";
import { AgentWorkspaceService } from "../../src/main/agent-workspace/service.js";
import type { AgentModel, AgentModelInput, AgentModelResult } from "../../src/main/agent/types.js";
import type { MainIpcContext } from "../../src/main/ipc/context.js";

const OWNER = 1001;

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

const call = (id: string, name: string, args: Record<string, unknown>): AgentModelResult => ({
  toolCalls: [{ id, name, arguments: args }],
});

test("七类文件动作逐个走完授权闭环，并留下可回读收据", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vbk-local-file-"));
  fs.writeFileSync(path.join(root, "note.md"), "第一版", "utf8");
  const db = new VbkDatabase(path.join(root, ".data"));
  const thread = db.createAgentThread(OWNER, { workingDirectory: root, title: "整理文件" });
  const runtime = createAgentRuntime(db);
  const model = new ScriptedModel([
    call("c1", "file.list", {}),
    call("c2", "file.read", { path: "note.md" }),
    call("c3", "file.create", { path: "new.md", content: "新建内容" }),
    call("c4", "file.modify", { path: "note.md", content: "第二版" }),
    call("c5", "file.overwrite", { path: "note.md", content: "覆盖版" }),
    call("c6", "file.move", { from: "new.md", to: "moved.md" }),
    call("c7", "file.delete", { path: "moved.md" }),
    { content: "七个动作都已完成。" },
  ]);
  const common = {
    ownerUserId: OWNER,
    threadId: thread.id,
    history: [{ role: "user" as const, content: "整理文件" }],
    workingDirectory: root,
    provider: async () => ({ model, systemPrompt: "系统说明" }),
  };

  let run = await runtime.runs.start({ ...common, intent: "整理文件" });
  let approvals = 0;
  while (run.status === "waiting_approval") {
    const approval = runtime.runs.snapshot({ ownerUserId: OWNER, threadId: thread.id, workingDirectory: root }).approval;
    assert.ok(approval, "等待审批时必须能拿到审批请求");
    run = await runtime.runs.approve({ ...common, toolCallId: approval.toolCallId, scope: "once" });
    approvals += 1;
  }
  assert.equal(run.status, "completed");
  assert.equal(approvals, 5, "五个写动作各需一次授权");

  assert.equal(fs.readFileSync(path.join(root, "note.md"), "utf8"), "覆盖版");
  assert.equal(fs.existsSync(path.join(root, "moved.md")), false, "删除应移入回收区");
  const trash = fs.readdirSync(path.join(root, ".agent-trash"));
  assert.equal(trash.length, 1);
  assert.match(trash[0], /moved\.md$/u);

  const receipts = db.listAgentActionReceipts(OWNER, thread.id);
  assert.deepEqual(receipts.map((receipt) => receipt.action), [
    "file.list", "file.read", "file.create", "file.modify", "file.overwrite", "file.move", "file.delete",
  ]);
  assert.ok(receipts.every((receipt) => receipt.status === "succeeded"), "每个动作都必须有成功收据");
  const toolCalls = db.listAgentToolCalls(OWNER, run.id);
  assert.ok(toolCalls.every((record) => record.status === "succeeded" && record.receiptId));
});

test("换工作目录后旧授权立即失效，写入重新要求审批", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "vbk-local-grant-"));
  const first = path.join(base, "first");
  const second = path.join(base, "second");
  fs.mkdirSync(first);
  fs.mkdirSync(second);
  const db = new VbkDatabase(path.join(base, "data"));
  const thread = db.createAgentThread(OWNER, { workingDirectory: first, title: "授权失效" });
  const run = db.createAgentRun(OWNER, { threadId: thread.id, intent: "写文件" });
  const toolCall = db.insertAgentToolCall(OWNER, {
    runId: run.id,
    threadId: thread.id,
    skillId: "local-file",
    toolName: "file.create",
    arguments: { path: "a.md", content: "A" },
    status: "awaiting_approval",
    kind: "write",
    risk: "medium",
    idempotencyKey: `${run.id}:c1`,
    summary: "新建文件 a.md",
  });
  db.createAgentPermissionGrant(OWNER, {
    threadId: thread.id,
    runId: run.id,
    toolCallId: toolCall.id,
    scope: "thread",
    action: "file.create",
    targetKey: first,
    accountKey: "local-fs",
  });
  const target = { action: "file.create", targetKey: path.join(first, "a.md"), accountKey: "local-fs", risk: "medium" as const };
  assert.equal(evaluatePermission({
    kind: "write", target, grants: db.listAgentPermissionGrants(OWNER, thread.id), toolCallId: toolCall.id,
  }).requiresApproval, false);

  const service = new AgentWorkspaceService({
    db,
    getExtensionUserId: () => OWNER,
  } as unknown as MainIpcContext);
  service.update(thread.id, { workingDirectory: second });

  const grants = db.listAgentPermissionGrants(OWNER, thread.id);
  assert.ok(grants.every((grant) => grant.revokedAt), "目录变更后授权必须全部失效");
  assert.equal(grants[0].revokedReason, "working_directory_changed");
  assert.equal(evaluatePermission({
    kind: "write",
    target: { ...target, targetKey: path.join(second, "a.md") },
    grants,
    toolCallId: toolCall.id,
  }).requiresApproval, true);
});

test("归档任务会撤销该任务的全部授权", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "vbk-local-archive-"));
  const db = new VbkDatabase(path.join(base, "data"));
  const thread = db.createAgentThread(OWNER, { workingDirectory: base, title: "归档" });
  const run = db.createAgentRun(OWNER, { threadId: thread.id, intent: "写文件" });
  db.createAgentPermissionGrant(OWNER, {
    threadId: thread.id,
    runId: run.id,
    toolCallId: "tc-1",
    scope: "thread",
    action: "file.create",
    targetKey: base,
    accountKey: "local-fs",
  });
  const service = new AgentWorkspaceService({
    db,
    getExtensionUserId: () => OWNER,
  } as unknown as MainIpcContext);
  service.update(thread.id, { status: "archived" });
  assert.equal(db.listAgentPermissionGrants(OWNER, thread.id)[0].revokedReason, "thread_archived");
});
