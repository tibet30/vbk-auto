import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { VbkDatabase } from "../../src/main/infrastructure/database/database.js";
import { ExternalToolRuntime, MCP_SERVERS_SETTING_KEY } from "../../src/main/agent-workspace/external-tools.js";
import { parseMcpServers } from "../../src/main/agent-runtime/mcp/config.js";

const fixtureServer = path.join(path.dirname(fileURLToPath(import.meta.url)), "../fixtures/mcp/fixture-server.mjs");

function seededDb(): VbkDatabase {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vbk-external-tools-"));
  return new VbkDatabase(path.join(dir, "data"));
}

function fixtureConfig(extra: Record<string, unknown> = {}) {
  return [{
    id: "fixture",
    label: "测试外部服务",
    command: process.execPath,
    args: [fixtureServer],
    env: {},
    timeoutMs: 8000,
    ...extra,
  }];
}

test("配置解析：坏 JSON 整体忽略，单条非法只跳过该条", () => {
  assert.deepEqual(parseMcpServers(undefined), { servers: [], skipped: [] });
  assert.deepEqual(parseMcpServers("{not json}").servers, []);
  assert.match(parseMcpServers("{not json}").skipped[0], /不是合法 JSON/u);
  assert.match(parseMcpServers('{"id":"x"}').skipped[0], /必须是数组/u);

  const parsed = parseMcpServers(JSON.stringify([
    { id: "a", command: "node", args: ["x.mjs"], env: { K: "v" } },
    { id: "a", command: "node" },
    { command: "node" },
    { id: "b", command: "node", timeoutMs: -5 },
  ]));
  assert.deepEqual(parsed.servers.map((server) => server.id), ["a", "b"]);
  assert.equal(parsed.servers[0].env?.K, "v");
  assert.equal(parsed.servers[1].timeoutMs, undefined, "非法超时不得生效");
  assert.equal(parsed.skipped.length, 2, "重复 id 与缺字段各跳过一条");
});

test("没有配置时不启动任何外部进程，状态为空", async () => {
  const db = seededDb();
  const runtime = new ExternalToolRuntime(db);
  const result = await runtime.refresh();
  assert.deepEqual(result.skills, []);
  assert.deepEqual(result.status, []);
  assert.deepEqual(runtime.skippedEntries(), []);
});

test("配置可用时发现外部工具，并暴露连接诊断", async () => {
  const db = seededDb();
  db.setSetting(MCP_SERVERS_SETTING_KEY, JSON.stringify(fixtureConfig()));
  const runtime = new ExternalToolRuntime(db);
  try {
    const { skills, status } = await runtime.refresh();
    assert.equal(skills.length, 1);
    assert.equal(skills[0].id, "mcp-fixture");
    assert.equal(status.length, 1);
    assert.equal(status[0].state, "ready");
    assert.equal(status[0].label, "测试外部服务");
    assert.deepEqual(status[0].tools.sort(), ["read_note", "slow_tool", "write_note"]);
    assert.deepEqual(status[0].changes, []);
    assert.equal(runtime.currentSkills().length, 1);
  } finally {
    await runtime.close();
  }
  assert.deepEqual(runtime.currentStatus(), [], "关闭后不再暴露残留状态");
});

test("外部服务起不来时只记诊断，不抛错也不影响内置能力", async () => {
  const db = seededDb();
  db.setSetting(MCP_SERVERS_SETTING_KEY, JSON.stringify([{
    id: "broken",
    label: "坏服务",
    command: "definitely-not-a-real-command",
    args: [],
    timeoutMs: 3000,
  }]));
  const runtime = new ExternalToolRuntime(db);
  try {
    const { skills, status } = await runtime.refresh();
    assert.deepEqual(skills, []);
    assert.equal(status[0].state, "failed");
    assert.ok(status[0].error);
  } finally {
    await runtime.close();
  }
});

test("坏配置在诊断里可见，而不是静默失效", async () => {
  const db = seededDb();
  db.setSetting(MCP_SERVERS_SETTING_KEY, "{broken");
  const runtime = new ExternalToolRuntime(db);
  const { skills, status } = await runtime.refresh();
  assert.deepEqual(skills, []);
  assert.equal(status.length, 1);
  assert.equal(status[0].state, "failed");
  assert.match(status[0].error ?? "", /不是合法 JSON/u);
  await runtime.close();
});

test("配置变化会重建连接来源，工具集合随之更新", async () => {
  const db = seededDb();
  const runtime = new ExternalToolRuntime(db);
  try {
    db.setSetting(MCP_SERVERS_SETTING_KEY, JSON.stringify(fixtureConfig()));
    const first = await runtime.refresh();
    assert.equal(first.skills.length, 1);

    db.setSetting(MCP_SERVERS_SETTING_KEY, JSON.stringify([]));
    const cleared = await runtime.refresh();
    assert.deepEqual(cleared.skills, []);
    assert.deepEqual(cleared.status, []);
    assert.deepEqual(runtime.currentSkills(), []);
  } finally {
    await runtime.close();
  }
});
