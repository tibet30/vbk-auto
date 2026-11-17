import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VbkDatabase } from "../../src/main/infrastructure/database/database.js";
import {
  createAgentRuntime,
  createVbkWriteSkill,
  type AgentSkillContext,
  type VbkProductBasicInfo,
  type VbkWriteGateResult,
  type VbkWritePort,
} from "../../src/main/agent-runtime/index.js";
import type { AgentModel, AgentModelInput, AgentModelResult } from "../../src/main/agent/types.js";

const OWNER = 1001;
const context: AgentSkillContext = { ownerUserId: OWNER, threadId: "t-1", runId: "r-1" };
const info: VbkProductBasicInfo = {
  title: "日喀则2天1晚私家团",
  meetingCity: "日喀则",
  days: 2,
  nights: 1,
  servicePhone: "400-820-6666",
  butlerName: "王管家",
};

function port(overrides: Partial<VbkWritePort> & { gateResult?: VbkWriteGateResult } = {}): VbkWritePort {
  const gateResult = overrides.gateResult ?? { allowed: true, accountKey: "vbk_671205", vbkProductId: "80664603", confirmationId: "approval-1" };
  return {
    gate: async () => gateResult,
    describeBasicInfo: async () => info,
    writeBasicInfo: async () => ({ result: "已保存" }),
    readBasicInfo: async () => ({ title: info.title, meetingCity: info.meetingCity }),
    ...overrides,
  };
}

test("产品门禁未通过时拒绝写入，并说明缺什么", async () => {
  const skill = createVbkWriteSkill(port({
    gateResult: { allowed: false, reason: "尚未完成运营确认（审核解锁状态：requires_review）" },
  }));
  await assert.rejects(
    () => skill.actions[0].target({ productId: "local-1" }, context),
    /产品门禁未通过，拒绝写入：尚未完成运营确认/u,
  );
});

test("门禁通过时写入目标带上真实后台账号与 VBK 产品 id", async () => {
  const skill = createVbkWriteSkill(port());
  const target = await skill.actions[0].target({ productId: "local-1" }, context);
  assert.equal(target.targetKey, "vbk:product:80664603");
  assert.equal(target.accountKey, "vbk_671205", "写入必须串行到真实后台账号，而不是技能名");
  assert.equal(target.kind, undefined);
});

test("审批卡预览展示将写入的基本信息与确认凭据", async () => {
  const skill = createVbkWriteSkill(port());
  const preview = await skill.actions[0].preview!({ productId: "local-1" }, context);
  assert.match(preview.summary, /VBK 产品 id 80664603/u);
  assert.match(preview.summary, /确认凭据 approval-1/u);
  assert.match(preview.diff ?? "", /标题：日喀则2天1晚私家团/u);
  assert.match(preview.diff ?? "", /400 电话：400-820-6666/u);
  assert.match(preview.diff ?? "", /管家联系人：王管家/u);
});

test("执行前记录前置状态：收据 before 写的是写入前 VBK 的值", async () => {
  const calls: string[] = [];
  const skill = createVbkWriteSkill(port({
    readBasicInfo: async () => {
      calls.push("read");
      return calls.length === 1 ? { title: "写入前的标题", meetingCity: "日喀则" } : { title: info.title };
    },
    writeBasicInfo: async () => {
      calls.push("write");
      return { result: "已保存" };
    },
  }));
  const result = await skill.actions[0].execute({ productId: "local-1" }, context);
  assert.equal(result.before, "写入前 VBK 标题：写入前的标题（日喀则）");
  assert.deepEqual(calls, ["read", "write"], "必须先回读前置状态，再写入");
});

test("前置状态读不到时如实记录，不阻断写入", async () => {
  const skill = createVbkWriteSkill(port({
    readBasicInfo: async () => { throw new Error("VBK 暂不可读"); },
  }));
  const result = await skill.actions[0].execute({ productId: "local-1" }, context);
  assert.equal(result.before, "写入前 VBK 未读到当前标题");
});

test("回读一致才算落地，不一致时如实报不一致", async () => {
  const matched = createVbkWriteSkill(port());
  const ok = await matched.actions[0].reconcile!({ productId: "local-1" }, context);
  assert.equal(ok.landed, true);
  assert.match(ok.detail, /回读标题一致/u);

  const drifted = createVbkWriteSkill(port({ readBasicInfo: async () => ({ title: "别的标题" }) }));
  const bad = await drifted.actions[0].reconcile!({ productId: "local-1" }, context);
  assert.equal(bad.landed, false);
  assert.match(bad.detail, /回读不一致/u);

  const missing = createVbkWriteSkill(port({ readBasicInfo: async () => ({}) }));
  assert.equal((await missing.actions[0].reconcile!({ productId: "local-1" }, context)).landed, false);
});

class ScriptedModel implements AgentModel {
  constructor(private readonly responses: AgentModelResult[]) {}

  async complete(_input: AgentModelInput): Promise<AgentModelResult> {
    const next = this.responses.shift();
    if (!next) throw new Error("模型脚本已用尽");
    return next;
  }
}

test("真实写入必须停在审批点，批准后才调用一次", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vbk-write-skill-"));
  const db = new VbkDatabase(path.join(dir, "data"));
  const thread = db.createAgentThread(OWNER, { title: "写 VBK" });
  let writes = 0;
  const runtime = createAgentRuntime(db, {
    skills: [],
    vbkWrite: port({
      writeBasicInfo: async () => {
        writes += 1;
        return { result: "已保存" };
      },
    }),
  });
  const model = new ScriptedModel([
    { toolCalls: [{ id: "call-1", name: "vbk.product.basicInfo", arguments: { productId: "local-1" } }] },
    { content: "已写入。" },
  ]);
  const common = {
    ownerUserId: OWNER,
    threadId: thread.id,
    history: [{ role: "user" as const, content: "把基本信息写到 VBK" }],
    provider: async () => ({ model, systemPrompt: "系统说明" }),
  };
  const waiting = await runtime.runs.start({ ...common, intent: "把基本信息写到 VBK" });
  assert.equal(waiting.status, "waiting_approval");
  assert.equal(writes, 0, "审批前不得发生任何后台写入");

  const approval = runtime.runs.snapshot({ ownerUserId: OWNER, threadId: thread.id }).approval!;
  assert.equal(approval.kind, "write");
  assert.equal(approval.risk, "high");
  assert.equal(approval.accountKey, "vbk_671205");

  const done = await runtime.runs.approve({ ...common, toolCallId: approval.toolCallId, scope: "once" });
  assert.equal(done.status, "completed");
  assert.equal(writes, 1);
  const receipts = db.listAgentActionReceipts(OWNER, thread.id);
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].action, "vbk.product.basicInfo");
  assert.equal(receipts[0].status, "succeeded");
  assert.equal(receipts[0].accountKey, "vbk_671205");
  assert.match(receipts[0].before ?? "", /写入前 VBK 标题/u, "写入收据必须带前置状态");
});
