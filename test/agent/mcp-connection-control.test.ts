import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { VbkDatabase } from "../../src/main/infrastructure/database/database.js";
import { createMcpSkillSource } from "../../src/main/agent-runtime/index.js";
import { ExternalToolRuntime, MCP_SERVERS_SETTING_KEY } from "../../src/main/agent-workspace/external-tools.js";
import { ExternalToolSettings } from "../../src/main/agent-workspace/external-tools-settings.js";

const fixtureServer = path.join(path.dirname(fileURLToPath(import.meta.url)), "../fixtures/mcp/fixture-server.mjs");

function servers() {
  return [
    { id: "fixture", label: "测试外部服务", command: process.execPath, args: [fixtureServer], env: {}, timeoutMs: 8000 },
    { id: "broken", label: "坏服务", command: "definitely-not-a-real-command", args: [], timeoutMs: 3000 },
  ];
}

function seededDb(): VbkDatabase {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vbk-mcp-control-"));
  const db = new VbkDatabase(path.join(dir, "data"));
  db.setSetting(MCP_SERVERS_SETTING_KEY, JSON.stringify(servers()));
  return db;
}

test("来源层：断开单个服务后它的工具消失，其他服务不受影响", async () => {
  const source = createMcpSkillSource({
    servers: [
      { id: "fixture", label: "测试外部服务", command: process.execPath, args: [fixtureServer], env: {}, timeoutMs: 8000 },
      { id: "fixture2", label: "测试外部服务 2", command: process.execPath, args: [fixtureServer], env: {}, timeoutMs: 8000 },
    ],
    ttlMs: 0,
  });
  try {
    const before = await source.discover();
    assert.equal(before.skills.length, 2);

    await source.setEnabled("fixture", false);
    const afterDisconnect = await source.discover();
    assert.deepEqual(afterDisconnect.skills.map((skill) => skill.id), ["mcp-fixture2"], "只影响被断开的服务");
    const closed = afterDisconnect.diagnostics.find((entry) => entry.serverId === "fixture")!;
    assert.equal(closed.state, "closed");
    assert.deepEqual(closed.tools, []);

    await source.setEnabled("fixture", true);
    const afterReconnect = await source.discover({ force: true });
    assert.equal(afterReconnect.skills.length, 2);
    assert.equal(afterReconnect.diagnostics.find((entry) => entry.serverId === "fixture")?.state, "ready");

    await assert.rejects(() => source.setEnabled("nope", false), /没有这个外部服务/u);
  } finally {
    await source.closeAll();
  }
});

test("运行时容器：断开坏服务后它从状态里标为已断开，好服务照常可用", async () => {
  const db = seededDb();
  const runtime = new ExternalToolRuntime(db);
  const settings = new ExternalToolSettings(runtime, () => {});
  try {
    const initial = await settings.read();
    const brokenBefore = initial.status.find((entry) => entry.serverId === "broken")!;
    assert.equal(brokenBefore.state, "failed");

    const afterDisconnect = await settings.setConnection("broken", false);
    const brokenAfter = afterDisconnect.status.find((entry) => entry.serverId === "broken")!;
    assert.equal(brokenAfter.state, "closed", "断开后不再显示失败，而是明确的已断开");
    assert.deepEqual(brokenAfter.tools, []);
    assert.equal(afterDisconnect.status.find((entry) => entry.serverId === "fixture")?.state, "ready");

    const afterReconnect = await settings.setConnection("broken", true);
    assert.equal(afterReconnect.status.find((entry) => entry.serverId === "broken")?.state, "failed", "坏服务重连仍是失败");
    assert.equal(afterReconnect.status.find((entry) => entry.serverId === "fixture")?.state, "ready");
  } finally {
    await runtime.close();
  }
});

test("断开后该服务的工具不再进入运行时 Skill 列表", async () => {
  const db = seededDb();
  const runtime = new ExternalToolRuntime(db);
  const settings = new ExternalToolSettings(runtime, () => {});
  try {
    await settings.read();
    assert.ok(runtime.currentSkills().some((skill) => skill.id === "mcp-fixture"));
    await settings.setConnection("fixture", false);
    assert.deepEqual(runtime.currentSkills().map((skill) => skill.id), [], "断开后不应再把该服务的工具交给模型");
    await settings.setConnection("fixture", true);
    assert.deepEqual(runtime.currentSkills().map((skill) => skill.id), ["mcp-fixture"]);
  } finally {
    await runtime.close();
  }
});

test("未知服务与未初始化状态都明确报错", async () => {
  const db = seededDb();
  const runtime = new ExternalToolRuntime(db);
  try {
    await assert.rejects(() => runtime.setConnection("nope", false), /没有这个外部服务/u);
  } finally {
    await runtime.close();
  }
});
