import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { VbkDatabase } from "../../src/main/infrastructure/database/database.js";
import { ExternalToolRuntime, MCP_SERVERS_SETTING_KEY } from "../../src/main/agent-workspace/external-tools.js";
import { ExternalToolSettings } from "../../src/main/agent-workspace/external-tools-settings.js";
import { validateMcpServersInput } from "../../src/main/agent-runtime/mcp/config.js";

const fixtureServer = path.join(path.dirname(fileURLToPath(import.meta.url)), "../fixtures/mcp/fixture-server.mjs");

function seededDb(): VbkDatabase {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vbk-mcp-settings-"));
  return new VbkDatabase(path.join(dir, "data"));
}

test("设置页输入校验：缺字段、非法 id、重复 id 都直接报错", () => {
  assert.match(validateMcpServersInput([{ command: "node" }]).error ?? "", /缺少 id/u);
  assert.match(validateMcpServersInput([{ id: "bad id", command: "node" }]).error ?? "", /只能用字母、数字与连字符/u);
  assert.match(
    validateMcpServersInput([{ id: "a", command: "node" }, { id: "a", command: "node" }]).error ?? "",
    /id 重复/u,
  );
  assert.match(validateMcpServersInput([{ id: "a" }]).error ?? "", /缺少启动命令/u);
  const ok = validateMcpServersInput([{ id: "a", command: "node", args: ["x.mjs"], timeoutMs: 5000 }]);
  assert.equal(ok.error, undefined);
  assert.deepEqual(ok.servers?.[0].args, ["x.mjs"]);
  assert.equal(ok.servers?.[0].timeoutMs, 5000);
});

test("保存配置会落库、重连，并通知对话链路重建运行时", async () => {
  const db = seededDb();
  const runtime = new ExternalToolRuntime(db);
  let rebuilds = 0;
  const settings = new ExternalToolSettings(runtime, () => { rebuilds += 1; });
  try {
    const disabled = await settings.read();
    assert.deepEqual(disabled.servers, []);
    assert.deepEqual(disabled.status, []);

    const saved = await settings.save([{
      id: "fixture",
      label: "测试外部服务",
      command: process.execPath,
      args: [fixtureServer],
      timeoutMs: 8000,
    }]);
    assert.equal(rebuilds, 1, "保存后必须通知重建，否则对话链路看不到新工具");
    assert.equal(saved.servers.length, 1);
    assert.equal(saved.servers[0].id, "fixture");
    assert.equal(saved.status[0].state, "ready");
    assert.ok(saved.status[0].tools.includes("write_note"));

    const stored = JSON.parse(db.getSetting(MCP_SERVERS_SETTING_KEY)!.value) as Array<Record<string, unknown>>;
    assert.equal(stored[0].command, process.execPath);
    assert.deepEqual(stored[0].args, [fixtureServer]);

    const refreshed = await settings.refresh();
    assert.equal(rebuilds, 2, "重新连接同样要通知重建");
    assert.equal(refreshed.status[0].state, "ready");
  } finally {
    await runtime.close();
  }
});

test("非法配置不落库，也不触发重连", async () => {
  const db = seededDb();
  const runtime = new ExternalToolRuntime(db);
  let rebuilds = 0;
  const settings = new ExternalToolSettings(runtime, () => { rebuilds += 1; });
  try {
    await assert.rejects(() => settings.save([{ id: "", command: "" }]), /缺少 id/u);
    assert.equal(db.getSetting(MCP_SERVERS_SETTING_KEY), undefined);
    assert.equal(rebuilds, 0);
  } finally {
    await runtime.close();
  }
});

test("界面不编辑 env，但保存时必须保留既有 env", async () => {
  const db = seededDb();
  db.setSetting(MCP_SERVERS_SETTING_KEY, JSON.stringify([{
    id: "fixture",
    command: process.execPath,
    args: [fixtureServer],
    env: { MCP_FIXTURE_VARIANT: "v2" },
  }]));
  const runtime = new ExternalToolRuntime(db);
  const settings = new ExternalToolSettings(runtime, () => {});
  try {
    await settings.read();
    await settings.save([{ id: "fixture", label: "改名", command: process.execPath, args: [fixtureServer] }]);
    const stored = JSON.parse(db.getSetting(MCP_SERVERS_SETTING_KEY)!.value) as Array<Record<string, unknown>>;
    assert.deepEqual(stored[0].env, { MCP_FIXTURE_VARIANT: "v2" }, "既有 env 不能被界面保存动作丢掉");
    assert.equal(stored[0].label, "改名");
  } finally {
    await runtime.close();
  }
});
