import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VbkDatabase } from "../../src/main/infrastructure/database/database.js";
import { createAgentRuntime, deckOutline, parseDeckPlan } from "../../src/main/agent-runtime/index.js";
import type { AgentModel, AgentModelInput, AgentModelResult } from "../../src/main/agent/types.js";

const OWNER = 1001;

const plan = {
  title: "日喀则2天1晚私家团 汇报",
  subtitle: "2026-11 运营周会",
  slides: [
    { layout: "cover", title: "日喀则2天1晚私家团" },
    {
      layout: "bullets",
      title: "产品要点",
      bullets: [
        "集合点：日喀则市城南街道吉林南路3号旅游服务中心",
        "住宿：平台自动匹配三四五钻",
        "交通：仅火车套餐",
      ],
    },
    { layout: "closing", title: "谢谢" },
  ],
};

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

function seed(): { dir: string; db: VbkDatabase; threadId: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vbk-deck-skill-"));
  const db = new VbkDatabase(path.join(dir, ".data"));
  const thread = db.createAgentThread(OWNER, { workingDirectory: dir, title: "做 PPT" });
  return { dir, db, threadId: thread.id };
}

async function runOnce(input: {
  db: VbkDatabase;
  threadId: string;
  dir: string;
  responses: AgentModelResult[];
}): Promise<{ status: string; approvalToolCallId?: string }> {
  const runtime = createAgentRuntime(input.db);
  const model = new ScriptedModel(input.responses);
  const common = {
    ownerUserId: OWNER,
    threadId: input.threadId,
    history: [{ role: "user" as const, content: "做一份汇报 PPT" }],
    workingDirectory: input.dir,
    provider: async () => ({ model, systemPrompt: "系统说明" }),
  };
  let run = await runtime.runs.start({ ...common, intent: "做一份汇报 PPT" });
  if (run.status !== "waiting_approval") return { status: run.status };
  const approval = runtime.runs.snapshot({ ownerUserId: OWNER, threadId: input.threadId, workingDirectory: input.dir }).approval!;
  const toolCallId = approval.toolCallId;
  run = await runtime.runs.approve({ ...common, toolCallId, scope: "once" });
  return { status: run.status, approvalToolCallId: toolCallId };
}

test("演示文稿计划受 Zod 约束：版式与字段不合规直接拒绝", () => {
  assert.ok("error" in parseDeckPlan({ title: "无页", slides: [] }));
  assert.ok("error" in parseDeckPlan({ title: "x", slides: [{ layout: "bullets", title: "没有要点" }] }));
  assert.ok("error" in parseDeckPlan({ title: "x", slides: [{ layout: "cover", title: "封面", bullets: ["不该有"] }] }));
  assert.ok("error" in parseDeckPlan({
    title: "x",
    slides: [{ layout: "bullets", title: "太多", bullets: Array.from({ length: 9 }, (_, index) => `要点 ${index}`) }],
  }));
  const good = parseDeckPlan(plan);
  assert.ok("plan" in good);
  assert.equal(good.plan.slides[1].bullets.length, 3);
  assert.match(deckOutline(good.plan), /共 3 页/u);
  assert.match(deckOutline(good.plan), /01\. \[cover\]/u);
});

test("生成 .pptx 需要授权，批准后落盘并可回读", async () => {
  const { dir, db, threadId } = seed();
  const runtime = createAgentRuntime(db);
  const model = new ScriptedModel([
    { toolCalls: [{ id: "call-1", name: "deck.generate", arguments: { plan } }] },
    { content: "已生成汇报 PPT。" },
  ]);
  const common = {
    ownerUserId: OWNER,
    threadId,
    history: [{ role: "user" as const, content: "做一份汇报 PPT" }],
    workingDirectory: dir,
    provider: async () => ({ model, systemPrompt: "系统说明" }),
  };

  const waiting = await runtime.runs.start({ ...common, intent: "做一份汇报 PPT" });
  assert.equal(waiting.status, "waiting_approval", "生成文件必须先经授权");
  const file = path.join(dir, "日喀则2天1晚私家团汇报.pptx");
  assert.equal(fs.existsSync(file), false, "批准前不得落盘");

  const approval = runtime.runs.snapshot({ ownerUserId: OWNER, threadId, workingDirectory: dir }).approval!;
  assert.equal(approval.actionLabel, "生成演示文稿");
  assert.match(approval.summary, /3 页/u);
  assert.match(approval.diff ?? "", /平台自动匹配三四五钻/u, "审批卡必须能看到大纲预览");

  const done = await runtime.runs.approve({ ...common, toolCallId: approval.toolCallId, scope: "once" });
  assert.equal(done.status, "completed");
  const buffer = fs.readFileSync(file);
  assert.equal(buffer.subarray(0, 2).toString("latin1"), "PK", "必须是 zip 容器格式的 .pptx");
  assert.ok(buffer.length > 5_000, `生成文件过小：${buffer.length}`);

  const receipts = db.listAgentActionReceipts(OWNER, threadId);
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].action, "deck.generate");
  assert.equal(receipts[0].status, "succeeded");
  assert.match(receipts[0].result, /3 页/u);
});

test("同名再生成时旧版归档到回收区，并留下第二张收据", async () => {
  const { dir, db, threadId } = seed();
  const target = "汇报.pptx";
  const first = await runOnce({
    db, threadId, dir,
    responses: [
      { toolCalls: [{ id: "call-1", name: "deck.generate", arguments: { path: target, plan } }] },
      { content: "第一版已生成。" },
    ],
  });
  assert.equal(first.status, "completed");

  const secondPlan = { ...plan, slides: [...plan.slides, { layout: "bullets", title: "新增一页", bullets: ["补充说明"] }] };
  const second = await runOnce({
    db, threadId, dir,
    responses: [
      { toolCalls: [{ id: "call-2", name: "deck.generate", arguments: { path: target, plan: secondPlan } }] },
      { content: "第二版已生成。" },
    ],
  });
  assert.equal(second.status, "completed");

  const trash = fs.readdirSync(path.join(dir, ".agent-trash"));
  assert.equal(trash.length, 1, "旧版必须进入可恢复回收区");
  assert.match(trash[0], /汇报\.pptx$/u);
  const receipts = db.listAgentActionReceipts(OWNER, threadId);
  assert.equal(receipts.length, 2);
  assert.match(receipts[1].result, /4 页/u);
});

test("越界路径与非 .pptx 目标都被拒绝，且不产生收据", async () => {
  const { dir, db, threadId } = seed();
  const runtime = createAgentRuntime(db);
  const model = new ScriptedModel([
    { toolCalls: [{ id: "call-1", name: "deck.generate", arguments: { path: "../evil.pptx", plan } }] },
    { toolCalls: [{ id: "call-2", name: "deck.generate", arguments: { path: "汇报.txt", plan } }] },
    { toolCalls: [{ id: "call-3", name: "deck.generate", arguments: { plan: { title: "坏计划", slides: [{ layout: "bullets", title: "空" }] } } }] },
    { content: "三次都被拒绝，请修正后再试。" },
  ]);
  const run = await runtime.runs.start({
    ownerUserId: OWNER,
    threadId,
    history: [{ role: "user" as const, content: "生成 PPT" }],
    workingDirectory: dir,
    intent: "生成 PPT",
    provider: async () => ({ model, systemPrompt: "系统说明" }),
  });
  assert.equal(run.status, "completed", "被拒绝的动作不应卡在审批点");
  assert.equal(db.listAgentActionReceipts(OWNER, threadId).length, 0);
  assert.equal(fs.readdirSync(dir).sort().join(","), ".data", "授权目录内不应出现任何文件");
  const toolCalls = db.listAgentToolCalls(OWNER, run.id);
  assert.equal(toolCalls.length, 0, "动作在解析目标阶段就失败，不登记为待审批");
});
