import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VbkDatabase } from "../../src/main/infrastructure/database/database.js";

test("通用智能体任务按用户隔离并持久化完整消息", () => {
  const dataPath = fs.mkdtempSync(path.join(os.tmpdir(), "vbk-agent-workspace-"));
  try {
    const db = new VbkDatabase(dataPath);
    const created = db.createAgentThread(1001, { title: "整理报价", workingDirectory: "/tmp/quotes" });
    db.addAgentThreadMessage(1001, created.id, "user", "读取报价文件");
    db.addAgentThreadMessage(1001, created.id, "assistant", "我会先核对目录授权。");

    const detail = db.getAgentThreadDetail(1001, created.id);
    assert.equal(detail.thread.messageCount, 2);
    assert.equal(detail.thread.workingDirectory, "/tmp/quotes");
    assert.deepEqual(detail.messages.map((message) => message.role), ["user", "assistant"]);
    assert.equal(db.listAgentThreads(1002).length, 0);
    assert.throws(() => db.getAgentThreadDetail(1002, created.id), /不存在/);
  } finally {
    fs.rmSync(dataPath, { recursive: true, force: true });
  }
});

test("置顶、摘要和归档独立更新且归档不删除历史", () => {
  const dataPath = fs.mkdtempSync(path.join(os.tmpdir(), "vbk-agent-workspace-update-"));
  try {
    const db = new VbkDatabase(dataPath);
    const thread = db.createAgentThread(1001, {});
    db.addAgentThreadMessage(1001, thread.id, "user", "保留这条消息");
    const summary = { revision: 1, coveredMessageCount: 1, text: "任务摘要", updatedAt: new Date().toISOString() };
    db.updateAgentThread(1001, thread.id, { title: "新的标题", pinned: true, summary });
    const archived = db.updateAgentThread(1001, thread.id, { status: "archived" });

    assert.equal(archived.title, "新的标题");
    assert.equal(archived.pinned, true);
    assert.equal(archived.status, "archived");
    assert.equal(archived.summary?.text, "任务摘要");
    assert.equal(db.getAgentThreadDetail(1001, thread.id).messages.length, 1);
  } finally {
    fs.rmSync(dataPath, { recursive: true, force: true });
  }
});

test("删除任务会同时清掉消息、运行与收据，且只作用于本人", () => {
  const dataPath = fs.mkdtempSync(path.join(os.tmpdir(), "vbk-agent-workspace-delete-"));
  try {
    const db = new VbkDatabase(dataPath);
    const thread = db.createAgentThread(1001, { title: "待删除任务" });
    db.addAgentThreadMessage(1001, thread.id, "user", "第一条");
    const run = db.createAgentRun(1001, { threadId: thread.id, intent: "整理报价" });
    assert.equal(db.listAgentRuns(1001, thread.id).length, 1);

    assert.throws(() => db.deleteAgentThread(1002, thread.id), /不存在/);
    assert.equal(db.listAgentThreads(1001).length, 1);

    db.deleteAgentThread(1001, thread.id);
    assert.equal(db.listAgentThreads(1001).length, 0);
    assert.equal(db.getAgentThread(1001, thread.id), undefined);
    assert.equal(db.listAgentRuns(1001, thread.id).length, 0);
    assert.equal(db.findActiveAgentRun(1001, thread.id), undefined);
    assert.throws(() => db.getAgentThreadDetail(1001, thread.id), /不存在/);
    assert.equal(run.threadId, thread.id);
  } finally {
    fs.rmSync(dataPath, { recursive: true, force: true });
  }
});

test("智能体产出消息置未读，打开任务后回到已读", () => {
  const dataPath = fs.mkdtempSync(path.join(os.tmpdir(), "vbk-agent-workspace-unread-"));
  try {
    const db = new VbkDatabase(dataPath);
    const thread = db.createAgentThread(1001, {});
    assert.equal(thread.unread, false);

    db.addAgentThreadMessage(1001, thread.id, "user", "开始整理");
    assert.equal(db.getAgentThread(1001, thread.id)?.unread, false);

    db.addAgentThreadMessage(1001, thread.id, "assistant", "已经整理完毕");
    assert.equal(db.getAgentThread(1001, thread.id)?.unread, true);

    db.markAgentThreadRead(1001, thread.id);
    assert.equal(db.getAgentThread(1001, thread.id)?.unread, false);
    assert.equal(db.listAgentThreads(1001)[0]?.unread, false);
  } finally {
    fs.rmSync(dataPath, { recursive: true, force: true });
  }
});
