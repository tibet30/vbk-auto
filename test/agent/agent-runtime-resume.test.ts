import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VbkDatabase } from "../../src/main/infrastructure/database/database.js";
import { createAgentRuntime } from "../../src/main/agent-runtime/index.js";
import type { AgentModel, AgentModelInput, AgentModelResult } from "../../src/main/agent/types.js";

const OWNER = 1001;

/** 前 failTimes 次调用抛错，之后按脚本返回：用于制造 needs_attention 后重试。 */
class RetryableModel implements AgentModel {
  private failures = 0;
  constructor(
    private readonly failTimes: number,
    private readonly responses: AgentModelResult[],
  ) {}

  async complete(_input: AgentModelInput): Promise<AgentModelResult> {
    if (this.failures < this.failTimes) {
      this.failures += 1;
      throw new Error("模型暂时不可用");
    }
    const next = this.responses.shift();
    if (!next) throw new Error("模型脚本已用尽");
    return next;
  }
}

function seed(): { dir: string; db: VbkDatabase; threadId: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vbk-agent-resume-"));
  const db = new VbkDatabase(path.join(dir, ".data"));
  const thread = db.createAgentThread(OWNER, { workingDirectory: dir, title: "继续运行" });
  return { dir, db, threadId: thread.id };
}

const history = [{ role: "user" as const, content: "整理目录" }];

test("模型报错后从中断处继续，不需要重发用户消息", async () => {
  const { dir, db, threadId } = seed();
  db.addAgentThreadMessage(OWNER, threadId, "user", "整理目录");
  const runtime = createAgentRuntime(db);
  const model = new RetryableModel(1, [{ content: "已经整理好了。" }]);
  const common = {
    ownerUserId: OWNER,
    threadId,
    history,
    workingDirectory: dir,
    provider: async () => ({ model, systemPrompt: "系统说明" }),
  };

  // 模型故障会向上抛，但运行事实已落库为 needs_attention（界面据此显示"继续运行"）。
  await assert.rejects(() => runtime.runs.start({ ...common, intent: "整理目录" }), /模型暂时不可用/u);
  const failed = db.findActiveAgentRun(OWNER, threadId)!;
  assert.equal(failed.status, "needs_attention");
  assert.match(failed.error ?? "", /模型暂时不可用/u);

  const resumed = await runtime.runs.resume({ ...common });
  assert.equal(resumed.status, "completed");
  const messages = db.getAgentThreadDetail(OWNER, threadId).messages;
  assert.equal(messages[messages.length - 1].content, "已经整理好了。");
  assert.equal(messages.filter((message) => message.role === "user").length, 1, "继续运行不应凭空新增用户消息");
});

test("撞到步数上限后继续会补足预算并跑完", async () => {
  const { dir, db, threadId } = seed();
  const runtime = createAgentRuntime(db);
  const run = db.createAgentRun(OWNER, { threadId, intent: "整理目录", maxSteps: 1 });
  db.insertAgentToolCall(OWNER, {
    runId: run.id,
    threadId,
    skillId: "local-file",
    toolName: "file.list",
    arguments: {},
    status: "succeeded",
    kind: "read",
    risk: "low",
    idempotencyKey: `${run.id}:call-1`,
    summary: "列出目录",
  });
  db.saveAgentRunTranscript(OWNER, run.id, [
    { role: "assistant", content: "", toolCalls: [{ id: "call-1", name: "file.list", arguments: {} }] },
    { role: "tool", content: "共 1 项", toolCallId: "call-1" },
  ]);
  const capped = db.updateAgentRun(OWNER, run.id, {
    status: "needs_attention",
    step: 1,
    error: "本次运行达到最大步数 1，请补充说明后继续。",
  });
  assert.equal(capped.maxSteps, 1);

  const model = new RetryableModel(0, [{ content: "目录已整理。" }]);
  const resumed = await runtime.runs.resume({
    ownerUserId: OWNER,
    threadId,
    history,
    workingDirectory: dir,
    provider: async () => ({ model, systemPrompt: "系统说明" }),
  });
  assert.equal(resumed.status, "completed");
  assert.ok(resumed.maxSteps > capped.maxSteps, "继续运行必须补足步数预算");
  assert.equal(resumed.error, undefined, "继续后应清掉上一次的阻塞原因");
});

test("待审批或结果不确定时不允许继续，必须先处理门禁", async () => {
  const { dir, db, threadId } = seed();
  const runtime = createAgentRuntime(db);
  const scripted = {
    async complete(): Promise<AgentModelResult> {
      return { toolCalls: [{ id: "call-1", name: "file.create", arguments: { path: "a.md", content: "A" } }] };
    },
  } satisfies AgentModel;
  const common = {
    ownerUserId: OWNER,
    threadId,
    history,
    workingDirectory: dir,
    provider: async () => ({ model: scripted, systemPrompt: "系统说明" }),
  };

  const waiting = await runtime.runs.start({ ...common, intent: "写文件" });
  assert.equal(waiting.status, "waiting_approval");
  await assert.rejects(() => runtime.runs.resume({ ...common }), /先批准或拒绝/u);

  const approval = runtime.runs.snapshot({ ownerUserId: OWNER, threadId, workingDirectory: dir }).approval!;
  await runtime.runs.reject({
    ownerUserId: OWNER, threadId, toolCallId: approval.toolCallId, reason: "先不写", workingDirectory: dir,
  });
  const rejected = db.listAgentRuns(OWNER, threadId, 1)[0];
  assert.equal(rejected.status, "rejected");
  await assert.rejects(() => runtime.runs.resume({ ...common }), /没有可继续的运行/u);
});

test("结果不确定的运行必须先核查，不能直接继续", async () => {
  const { dir, db, threadId } = seed();
  const runtime = createAgentRuntime(db);
  const run = db.createAgentRun(OWNER, { threadId, intent: "写文件" });
  db.updateAgentRun(OWNER, run.id, { status: "uncertain", error: "写入状态不明" });
  await assert.rejects(
    () => runtime.runs.resume({
      ownerUserId: OWNER,
      threadId,
      history,
      workingDirectory: dir,
      provider: async () => ({ model: new RetryableModel(0, []), systemPrompt: "系统说明" }),
    }),
    /请先核查结果再继续/u,
  );
});

test("transcript 停在未补结果的工具调用上时拒绝继续，避免协议断档", async () => {
  const { dir, db, threadId } = seed();
  const runtime = createAgentRuntime(db);
  const run = db.createAgentRun(OWNER, { threadId, intent: "写文件" });
  db.saveAgentRunTranscript(OWNER, run.id, [
    { role: "assistant", content: "", toolCalls: [{ id: "call-9", name: "file.create", arguments: {} }] },
  ]);
  db.updateAgentRun(OWNER, run.id, { status: "needs_attention", error: "中断" });
  await assert.rejects(
    () => runtime.runs.resume({
      ownerUserId: OWNER,
      threadId,
      history,
      workingDirectory: dir,
      provider: async () => ({ model: new RetryableModel(0, []), systemPrompt: "系统说明" }),
    }),
    /还有未完成的工具调用/u,
  );
});
