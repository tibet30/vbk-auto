// 任务删除服务的行为：执行中的运行拦住删除，可清理的任务连同运行记录一起消失。
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VbkDatabase } from "../../src/main/infrastructure/database/database.js";
import { AgentWorkspaceService } from "../../src/main/agent-workspace/service.js";
import type { MainIpcContext } from "../../src/main/ipc/context.js";

const OWNER = 1001;

function service(db: VbkDatabase): AgentWorkspaceService {
  return new AgentWorkspaceService({ db, getExtensionUserId: () => OWNER } as unknown as MainIpcContext);
}

test("执行中的任务不允许删除", () => {
  const dataPath = fs.mkdtempSync(path.join(os.tmpdir(), "vbk-agent-remove-active-"));
  try {
    const db = new VbkDatabase(dataPath);
    const thread = db.createAgentThread(OWNER, { title: "正在运行" });
    const run = db.createAgentRun(OWNER, { threadId: thread.id, intent: "整理今天的订单" });
    db.updateAgentRun(OWNER, run.id, { status: "running" });

    assert.throws(() => service(db).remove(thread.id), /未结束的运行/);
    assert.equal(db.listAgentThreads(OWNER).length, 1);
  } finally {
    fs.rmSync(dataPath, { recursive: true, force: true });
  }
});

test("任务删除后列表、详情与运行记录都不再可见", () => {
  const dataPath = fs.mkdtempSync(path.join(os.tmpdir(), "vbk-agent-remove-"));
  try {
    const db = new VbkDatabase(dataPath);
    const workspace = service(db);
    const thread = db.createAgentThread(OWNER, { title: "准备删除" });
    db.addAgentThreadMessage(OWNER, thread.id, "user", "先记一条");
    const run = db.createAgentRun(OWNER, { threadId: thread.id, intent: "整理报价" });
    db.updateAgentRun(OWNER, run.id, { status: "needs_attention" });

    workspace.remove(thread.id);
    assert.deepEqual(workspace.list(), []);
    assert.throws(() => workspace.get(thread.id), /不存在/);
    assert.equal(db.listAgentRuns(OWNER, thread.id).length, 0);
    assert.equal(db.findActiveAgentRun(OWNER, thread.id), undefined);
  } finally {
    fs.rmSync(dataPath, { recursive: true, force: true });
  }
});
