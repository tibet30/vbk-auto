import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VbkDatabase } from "../../src/main/infrastructure/database/database.js";
import { createAgentRuntime, createAccountReadSkill, type AgentSkillContext } from "../../src/main/agent-runtime/index.js";
import { buildAccountReadPort } from "../../src/main/agent-workspace/ports.js";
import type { AgentModel, AgentModelInput, AgentModelResult } from "../../src/main/agent/types.js";

const OWNER = 1001;
const context: AgentSkillContext = { ownerUserId: OWNER, threadId: "t-1", runId: "r-1" };

function seededDb(): VbkDatabase {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vbk-account-read-"));
  const db = new VbkDatabase(path.join(dir, "data"));
  db.setProviderIdFor("vbk_671205", 3388899);
  db.setAccountFixedInfo("小璐", {
    servicePhone: "400-820-6666",
    butlerName: { contactCardId: 66, displayName: "王管家", providerId: 3388899 },
  });
  return db;
}

function snapshot() {
  return {
    current: { accountKey: "vbk_671205", accountName: "小璐", lastUsedAt: "2026-11-15T08:00:00.000Z" },
    saved: [{ accountKey: "vbk_700001", accountName: "阿豪", lastUsedAt: "2026-11-10T08:00:00.000Z" }],
  };
}

test("账号 Skill 只注册只读动作", () => {
  const skill = createAccountReadSkill({ accounts: () => [] });
  assert.deepEqual(skill.actions.map((action) => action.name), ["account.list", "account.status"]);
  assert.ok(skill.actions.every((action) => action.kind === "read" && action.risk === "low"));
});

test("端口把本机 cookie 记录与账号固定信息投影成只读记录", () => {
  const db = seededDb();
  const port = buildAccountReadPort({ db, browser: { listKnownLoginAccounts: snapshot } });
  const records = port.accounts();
  assert.equal(records.length, 2);
  assert.deepEqual(records.map((record) => record.accountName), ["小璐", "阿豪"]);
  assert.equal(records[0].active, true);
  assert.equal(records[1].active, false);
  assert.equal(records[0].providerId, 3388899, "providerId 允许按 accountKey 或展示名回退");
  assert.equal(records[1].providerId, undefined);
  assert.equal(records[0].servicePhone, "400-820-6666");
  assert.equal(records[0].butlerName, "王管家", "联系人取展示名，不外泄联系人卡内部结构");
  assert.equal(records[1].butlerName, undefined);
});

test("没有 cookie 记录或浏览器时如实返回空，不编造账号", () => {
  const db = seededDb();
  assert.deepEqual(buildAccountReadPort({ db }).accounts(), []);
  assert.deepEqual(buildAccountReadPort({ db, browser: { listKnownLoginAccounts: () => ({ current: null, saved: [] }) } }).accounts(), []);
});

test("账号列表不冒充登录状态，电话要打码", async () => {
  const port = buildAccountReadPort({ db: seededDb(), browser: { listKnownLoginAccounts: snapshot } });
  const skill = createAccountReadSkill(port);
  const result = await skill.actions[0].execute({}, context);
  assert.match(result.content, /本机保存 2 个 VBK 账号/u);
  assert.match(result.content, /小璐（vbk_671205）· 当前选中/u);
  assert.match(result.content, /400 电话：400-\*\*\*\*66/u);
  assert.match(result.content, /管家联系人：王管家/u);
  assert.match(result.content, /不代表 VBK 当前页面的实时登录状态/u);
  assert.doesNotMatch(result.content, /已登录/u, "不得据本地记录宣布登录成功");
});

test("账号详情默认取当前选中，也可按账号键或唯一前缀指定", async () => {
  const skill = createAccountReadSkill(buildAccountReadPort({
    db: seededDb(),
    browser: { listKnownLoginAccounts: snapshot },
  }));
  const status = skill.actions[1];
  const current = await status.execute({}, context);
  assert.match(current.content, /vbk_671205/u);

  const explicit = await status.execute({ accountKey: "vbk_700001" }, context);
  assert.match(explicit.content, /阿豪（vbk_700001）/u);

  const byName = await status.execute({ accountKey: "阿豪" }, context);
  assert.match(byName.content, /vbk_700001/u);

  await assert.rejects(() => status.execute({ accountKey: "vbk_999" }, context), /本机没有这个账号记录/u);
});

test("没有账号时详情直接报错，不给假结论", async () => {
  const skill = createAccountReadSkill({ accounts: () => [] });
  await assert.rejects(() => skill.actions[1].execute({}, context), /还没有保存任何 VBK 登录账号/u);
  const list = await skill.actions[0].execute({}, context);
  assert.match(list.content, /本机还没有保存任何 VBK 登录账号/u);
  assert.match(list.content, /不代表 VBK 当前页面的实时登录状态/u);
});

class ScriptedModel implements AgentModel {
  constructor(private readonly responses: AgentModelResult[]) {}

  async complete(_input: AgentModelInput): Promise<AgentModelResult> {
    const next = this.responses.shift();
    if (!next) throw new Error("模型脚本已用尽");
    return next;
  }
}

test("账号查询在对话中直接执行并留下审计收据", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vbk-account-runtime-"));
  const db = seededDb();
  const thread = db.createAgentThread(OWNER, { title: "查账号" });
  const runtime = createAgentRuntime(db, {
    accounts: buildAccountReadPort({ db, browser: { listKnownLoginAccounts: snapshot } }),
  });
  const model = new ScriptedModel([
    { toolCalls: [{ id: "call-1", name: "account.list", arguments: {} }] },
    { content: "本机有两个账号，当前选中的是小璐。" },
  ]);
  const run = await runtime.runs.start({
    ownerUserId: OWNER,
    threadId: thread.id,
    history: [{ role: "user", content: "现在本机配了哪些 VBK 账号" }],
    intent: "现在本机配了哪些 VBK 账号",
    provider: async () => ({ model, systemPrompt: "系统说明" }),
  });
  assert.equal(run.status, "completed", "只读查询不应停在审批点");
  const receipts = db.listAgentActionReceipts(OWNER, thread.id);
  assert.deepEqual(receipts.map((receipt) => receipt.action), ["account.list"]);
  assert.equal(receipts[0].status, "succeeded");
});
