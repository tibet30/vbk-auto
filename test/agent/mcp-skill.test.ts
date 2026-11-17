import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { VbkDatabase } from "../../src/main/infrastructure/database/database.js";
import {
  AgentUncertainActionError,
  createAgentRuntime,
  createMcpSkillSource,
  type McpServerConfig,
} from "../../src/main/agent-runtime/index.js";
import type { AgentModel, AgentModelInput, AgentModelResult } from "../../src/main/agent/types.js";

const OWNER = 1001;
const fixtureServer = path.join(path.dirname(fileURLToPath(import.meta.url)), "../fixtures/mcp/fixture-server.mjs");

function fixtureConfig(env: Record<string, string> = {}): McpServerConfig {
  return {
    id: "fixture",
    label: "测试外部服务",
    command: process.execPath,
    args: [fixtureServer],
    env,
    timeoutMs: 8000,
  };
}

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "vbk-mcp-"));
}

test("MCP 发现：只读工具按只读处理，其余一律按写入处理", async () => {
  const source = createMcpSkillSource({ servers: [fixtureConfig()], ttlMs: 0 });
  try {
    const { skills, diagnostics } = await source.discover();
    assert.equal(skills.length, 1, JSON.stringify(diagnostics));
    assert.deepEqual(diagnostics[0].tools.sort(), ["read_note", "slow_tool", "write_note"]);
    assert.equal(diagnostics[0].state, "ready");
    const byName = new Map(skills[0].actions.map((action) => [action.name, action]));
    assert.equal(byName.get("mcp.fixture.read_note")?.kind, "read");
    assert.equal(byName.get("mcp.fixture.write_note")?.kind, "write", "没有 readOnlyHint 的工具必须按写入处理");
    assert.equal(byName.get("mcp.fixture.slow_tool")?.kind, "write");
    assert.equal(byName.get("mcp.fixture.write_note")?.risk, "medium");
  } finally {
    await source.closeAll();
  }
});

test("工具可读可写，写入会真的到达外部进程", async () => {
  const dir = tempDir();
  const log = path.join(dir, "notes.log");
  const source = createMcpSkillSource({ servers: [fixtureConfig({ MCP_FIXTURE_LOG: log })], ttlMs: 0 });
  try {
    const { skills } = await source.discover();
    const actions = new Map(skills[0].actions.map((action) => [action.name, action]));
    const context = { ownerUserId: OWNER, threadId: "t-1", runId: "r-1" };

    const read = await actions.get("mcp.fixture.read_note")!.execute({ key: "k1" }, context);
    assert.equal(read.content, "note:k1");

    const write = await actions.get("mcp.fixture.write_note")!.execute({ key: "k2", text: "你好" }, context);
    assert.match(write.content, /written k2/u);
    assert.equal(fs.readFileSync(log, "utf8"), "k2=你好\n");
  } finally {
    await source.closeAll();
  }
});

test("外部调用超时按「结果不确定」处理，不当作普通失败", async () => {
  const source = createMcpSkillSource({ servers: [{ ...fixtureConfig(), timeoutMs: 400 }], ttlMs: 0 });
  try {
    const { skills } = await source.discover();
    const slow = skills[0].actions.find((action) => action.name === "mcp.fixture.slow_tool")!;
    await assert.rejects(
      () => slow.execute({ ms: 3000 }, { ownerUserId: OWNER, threadId: "t-1", runId: "r-1" }),
      (error: unknown) => {
        assert.ok(error instanceof AgentUncertainActionError, `实际错误：${String(error)}`);
        assert.match(error.message, /超时/u);
        return true;
      },
    );
  } finally {
    await source.closeAll();
  }
});

test("server 升级导致工具 Schema 变化时可诊断", async () => {
  const env: Record<string, string> = { MCP_FIXTURE_VARIANT: "base" };
  const source = createMcpSkillSource({ servers: [fixtureConfig(env)], ttlMs: 0 });
  try {
    const first = await source.discover();
    assert.deepEqual(first.diagnostics[0].changes, [], "首次发现没有历史可比");

    env.MCP_FIXTURE_VARIANT = "v2";
    const second = await source.discover({ force: true });
    assert.ok(
      second.diagnostics[0].changes.some((change) => change.includes("write_note") && change.includes("Schema")),
      `应报告 write_note 的 Schema 变化，实际：${JSON.stringify(second.diagnostics[0].changes)}`,
    );
    const write = second.skills[0].actions.find((action) => action.name === "mcp.fixture.write_note")!;
    assert.ok(JSON.stringify(write.parameters).includes("author"), "新参数必须进入模型可见的 Schema");
  } finally {
    await source.closeAll();
  }
});

test("外部 server 不可用时只记诊断，不影响其他 Skill", async () => {
  const source = createMcpSkillSource({
    servers: [
      { id: "broken", label: "坏服务", command: "definitely-not-a-real-command", args: [], timeoutMs: 3000 },
      fixtureConfig(),
    ],
    ttlMs: 0,
  });
  try {
    const { skills, diagnostics } = await source.discover();
    assert.equal(skills.length, 1, "坏服务不能拖垮整轮发现");
    const broken = diagnostics.find((entry) => entry.serverId === "broken")!;
    assert.equal(broken.state, "failed");
    assert.ok(broken.error);
    assert.equal(source.diagnostics().length, 2);
  } finally {
    await source.closeAll();
  }
});

class ScriptedModel implements AgentModel {
  constructor(private readonly responses: AgentModelResult[]) {}

  async complete(_input: AgentModelInput): Promise<AgentModelResult> {
    const next = this.responses.shift();
    if (!next) throw new Error("模型脚本已用尽");
    return next;
  }
}

test("外部写工具与内置写工具走同一条审批与收据路径", async () => {
  const dir = tempDir();
  const log = path.join(dir, "notes.log");
  const source = createMcpSkillSource({ servers: [fixtureConfig({ MCP_FIXTURE_LOG: log })], ttlMs: 0 });
  try {
    const { skills } = await source.discover();
    const db = new VbkDatabase(path.join(dir, "data"));
    const thread = db.createAgentThread(OWNER, { title: "外部工具" });
    const runtime = createAgentRuntime(db, { extraSkills: skills });
    const model = new ScriptedModel([
      { toolCalls: [{ id: "call-1", name: "mcp.fixture.write_note", arguments: { key: "k9", text: "外部写入" } }] },
      { content: "已写入外部便签。" },
    ]);
    const common = {
      ownerUserId: OWNER,
      threadId: thread.id,
      history: [{ role: "user" as const, content: "写一条便签" }],
      provider: async () => ({ model, systemPrompt: "系统说明" }),
    };

    const waiting = await runtime.runs.start({ ...common, intent: "写一条便签" });
    assert.equal(waiting.status, "waiting_approval", "外部写工具同样必须先审批");
    assert.equal(fs.existsSync(log), false, "审批前外部世界不能有任何变化");

    const approval = runtime.runs.snapshot({ ownerUserId: OWNER, threadId: thread.id }).approval!;
    assert.equal(approval.skillId, "mcp-fixture");
    assert.match(approval.summary, /测试外部服务\.write_note/u);
    assert.match(approval.diff ?? "", /"key":"k9"/u, "审批卡必须展示将发送的真实参数");

    const done = await runtime.runs.approve({ ...common, toolCallId: approval.toolCallId, scope: "once" });
    assert.equal(done.status, "completed");
    assert.equal(fs.readFileSync(log, "utf8"), "k9=外部写入\n");

    const receipts = db.listAgentActionReceipts(OWNER, thread.id);
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0].action, "mcp.fixture.write_note");
    assert.equal(receipts[0].accountKey, "mcp:fixture");
    assert.equal(receipts[0].status, "succeeded");
  } finally {
    await source.closeAll();
  }
});
