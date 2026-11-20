// 临时工作区行为：未指定目录时自动创建、丢失后重建、删除任务回收、启动清理孤儿目录。

import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VbkDatabase } from "../../src/main/infrastructure/database/database.js";
import { AgentWorkspaceService } from "../../src/main/agent-workspace/service.js";
import {
  resolveTemporaryWorkspaceRoot,
  ThreadWorkspaceDirectory,
} from "../../src/main/agent-workspace/workspace-directory.js";
import type { MainIpcContext } from "../../src/main/ipc/context.js";

const OWNER = 1001;

function service(db: VbkDatabase, temporaryWorkspaceRoot: string): AgentWorkspaceService {
  return new AgentWorkspaceService(
    { db, getExtensionUserId: () => OWNER } as unknown as MainIpcContext,
    { temporaryWorkspaceRoot },
  );
}

test("临时工作区根目录优先取显式配置，其次取环境变量，最后回落到系统临时目录", () => {
  const previous = process.env.VBK_AGENT_WORKSPACE_ROOT;
  try {
    assert.equal(resolveTemporaryWorkspaceRoot("/tmp/vbk-explicit"), path.resolve("/tmp/vbk-explicit"));
    process.env.VBK_AGENT_WORKSPACE_ROOT = "/tmp/vbk-from-env";
    assert.equal(resolveTemporaryWorkspaceRoot(), path.resolve("/tmp/vbk-from-env"));
    delete process.env.VBK_AGENT_WORKSPACE_ROOT;
    assert.equal(resolveTemporaryWorkspaceRoot(), path.join(os.tmpdir(), "vbk-agent-workspaces"));
  } finally {
    if (previous === undefined) delete process.env.VBK_AGENT_WORKSPACE_ROOT;
    else process.env.VBK_AGENT_WORKSPACE_ROOT = previous;
  }
});

test("未指定目录的任务在执行前拿到临时工作区，并写回任务记录", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "vbk-temp-workspace-"));
  const root = path.join(base, "agent-workspaces");
  try {
    const workspace = service(new VbkDatabase(path.join(base, ".data")), root);
    const thread = workspace.create({ title: "做一份产品介绍演示稿" });
    assert.equal(thread.workingDirectory, undefined);

    const directory = await workspace.prepareWorkingDirectory(thread.id);
    assert.equal(directory, path.join(root, String(OWNER), thread.id));
    assert.equal(fs.statSync(directory).isDirectory(), true);

    const detail = workspace.get(thread.id);
    assert.equal(detail.thread.workingDirectory, directory);
    assert.equal(detail.workingDirectoryKind, "temporary");
    assert.equal(detail.workingDirectoryAvailable, true);
    assert.equal(await workspace.prepareWorkingDirectory(thread.id), directory);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("临时工作区被外部清掉后自动重建，用户目录只保留原路径不重建", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "vbk-temp-workspace-rebuild-"));
  const root = path.join(base, "agent-workspaces");
  try {
    const workspace = service(new VbkDatabase(path.join(base, ".data")), root);
    const temporary = workspace.create({ title: "临时目录" });
    const directory = await workspace.prepareWorkingDirectory(temporary.id);
    fs.rmSync(directory, { recursive: true, force: true });

    const rebuilt = await workspace.prepareWorkingDirectory(temporary.id);
    assert.equal(rebuilt, directory);
    assert.equal(fs.statSync(rebuilt).isDirectory(), true);

    const chosen = path.join(base, "chosen");
    fs.mkdirSync(chosen);
    const userThread = workspace.create({ title: "用户目录", workingDirectory: chosen });
    fs.rmSync(chosen, { recursive: true, force: true });
    assert.equal(await workspace.prepareWorkingDirectory(userThread.id), chosen);
    assert.equal(fs.existsSync(chosen), false);
    assert.equal(workspace.get(userThread.id).workingDirectoryKind, "user");
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("删除任务回收它的临时工作区，用户选择的目录一律不动", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "vbk-temp-workspace-remove-"));
  const root = path.join(base, "agent-workspaces");
  try {
    const workspace = service(new VbkDatabase(path.join(base, ".data")), root);
    const temporary = workspace.create({ title: "会回收" });
    const directory = await workspace.prepareWorkingDirectory(temporary.id);
    fs.writeFileSync(path.join(directory, "deck.pptx"), "占位", "utf8");

    const chosen = path.join(base, "chosen");
    fs.mkdirSync(chosen);
    const kept = workspace.create({ title: "不会删", workingDirectory: chosen });

    workspace.remove(temporary.id);
    assert.equal(fs.existsSync(directory), false);
    workspace.remove(kept.id);
    assert.equal(fs.statSync(chosen).isDirectory(), true);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("启动清理只回收没有任务引用的临时目录", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "vbk-temp-workspace-prune-"));
  const root = path.join(base, "agent-workspaces");
  try {
    const db = new VbkDatabase(path.join(base, ".data"));
    const workspace = service(db, root);
    const alive = workspace.create({ title: "仍在" });
    const aliveDirectory = await workspace.prepareWorkingDirectory(alive.id);
    const orphan = new ThreadWorkspaceDirectory(root);
    const orphanId = "11111111-1111-4111-8111-111111111111";
    const otherId = "22222222-2222-4222-8222-222222222222";
    await orphan.ensure({ ownerUserId: OWNER, id: orphanId });
    await orphan.ensure({ ownerUserId: OWNER + 1, id: otherId });
    await orphan.ensure({ ownerUserId: OWNER, id: "user-folder" });

    const removed = orphan.prune((ownerUserId, threadId) => db.getAgentThread(ownerUserId, threadId)?.workingDirectory);
    assert.equal(removed, 2);
    assert.equal(fs.existsSync(aliveDirectory), true);
    assert.equal(fs.existsSync(path.join(root, String(OWNER), orphanId)), false);
    assert.equal(fs.existsSync(path.join(root, String(OWNER + 1), otherId)), false);
    assert.equal(fs.existsSync(path.join(root, String(OWNER), "user-folder")), true);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("清空工作目录会立即回收临时工作区，下次执行再建", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "vbk-temp-workspace-clear-"));
  const root = path.join(base, "agent-workspaces");
  try {
    const workspace = service(new VbkDatabase(path.join(base, ".data")), root);
    const thread = workspace.create({ title: "清空目录" });
    const directory = await workspace.prepareWorkingDirectory(thread.id);

    workspace.update(thread.id, { workingDirectory: null });
    assert.equal(workspace.get(thread.id).thread.workingDirectory, undefined);
    assert.equal(fs.existsSync(directory), false);

    assert.equal(await workspace.prepareWorkingDirectory(thread.id), directory);
    assert.equal(fs.existsSync(directory), true);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
