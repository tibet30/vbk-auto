import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VbkDatabase } from "../../src/main/infrastructure/database/database.js";
import { createAgentRuntime, parseWebPlan, webSkill } from "../../src/main/agent-runtime/index.js";
import type { AgentModel, AgentModelInput, AgentModelResult } from "../../src/main/agent/types.js";
import type { AgentSkillContext } from "../../src/main/agent-runtime/index.js";

const OWNER = 1001;

const plan = {
  title: "日喀则产品说明页",
  description: "对客说明：集合点、住宿与交通",
  sections: [
    { heading: "集合与取车", body: "日喀则市城南街道吉林南路3号旅游服务中心" },
    { heading: "住宿", bullets: ["平台自动匹配三四五钻", "逐晚保留实际住宿城市"] },
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vbk-web-skill-"));
  const db = new VbkDatabase(path.join(dir, ".data"));
  const thread = db.createAgentThread(OWNER, { workingDirectory: dir, title: "做网页" });
  return { dir, db, threadId: thread.id };
}

async function approveOnce(input: {
  db: VbkDatabase;
  threadId: string;
  dir: string;
  responses: AgentModelResult[];
}): Promise<string> {
  const runtime = createAgentRuntime(input.db);
  const model = new ScriptedModel(input.responses);
  const common = {
    ownerUserId: OWNER,
    threadId: input.threadId,
    history: [{ role: "user" as const, content: "做一个说明页" }],
    workingDirectory: input.dir,
    provider: async () => ({ model, systemPrompt: "系统说明" }),
  };
  const run = await runtime.runs.start({ ...common, intent: "做一个说明页" });
  assert.equal(run.status, "waiting_approval");
  const approval = runtime.runs.snapshot({ ownerUserId: OWNER, threadId: input.threadId, workingDirectory: input.dir }).approval!;
  await runtime.runs.approve({ ...common, toolCallId: approval.toolCallId, scope: "once" });
  return approval.toolCallId;
}

test("网页计划受 Zod 约束", () => {
  assert.ok("error" in parseWebPlan({ title: "空", sections: [] }));
  assert.ok("error" in parseWebPlan({ title: "空", sections: [{ heading: "  " }] }));
  const good = parseWebPlan(plan);
  assert.ok("plan" in good);
  assert.equal(good.plan.sections.length, 2);
  assert.equal(good.plan.theme, "kaimu-light", "主题有默认值");
});

test("生成静态网页需要授权，批准后落盘为可预览工程", async () => {
  const { dir, db, threadId } = seed();
  const toolCallId = await approveOnce({
    db, threadId, dir,
    responses: [
      { toolCalls: [{ id: "call-1", name: "web.build", arguments: { path: "site", plan } }] },
      { content: "网页已生成。" },
    ],
  });
  assert.ok(toolCallId);

  const site = path.join(dir, "site");
  assert.deepEqual(fs.readdirSync(site).sort(), ["README.md", "index.html", "styles.css"]);
  const html = fs.readFileSync(path.join(site, "index.html"), "utf8");
  assert.match(html, /<title>日喀则产品说明页<\/title>/u);
  assert.match(html, /日喀则市城南街道吉林南路3号旅游服务中心/u);
  assert.match(html, /<h2>住宿<\/h2>/u);
  assert.match(html, /平台自动匹配三四五钻/u);
  assert.match(html, /href="styles\.css"/u, "样式必须外链，便于直接本地预览");
  const receipts = db.listAgentActionReceipts(OWNER, threadId);
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].action, "web.build");
  assert.match(receipts[0].result, /3 个文件/u);
});

test("模型文本一律转义，不产生脚本注入", async () => {
  const { dir, db, threadId } = seed();
  await approveOnce({
    db, threadId, dir,
    responses: [
      {
        toolCalls: [{
          id: "call-1",
          name: "web.build",
          arguments: {
            path: "escaped",
            plan: {
              title: "标题 <script>alert(1)</script>",
              description: '描述 "双引号" & 与号',
              sections: [{ heading: "<img src=x onerror=alert(2)>", bullets: ["<b>粗体不应生效</b>"] }],
            },
          },
        }],
      },
      { content: "已生成。" },
    ],
  });
  const html = fs.readFileSync(path.join(dir, "escaped", "index.html"), "utf8");
  assert.equal(html.includes("<script>alert(1)</script>"), false);
  assert.equal(html.includes("<img src=x"), false);
  assert.equal(html.includes("<b>粗体不应生效</b>"), false);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/u);
  assert.match(html, /&quot;双引号&quot;/u);
});

test("同目录再生成时旧版整目录归档，新旧文件不混在一起", async () => {
  const { dir, db, threadId } = seed();
  await approveOnce({
    db, threadId, dir,
    responses: [
      { toolCalls: [{ id: "call-1", name: "web.build", arguments: { path: "site", plan } }] },
      { content: "第一版。" },
    ],
  });
  const firstHtml = fs.readFileSync(path.join(dir, "site", "index.html"), "utf8");

  await approveOnce({
    db, threadId, dir,
    responses: [
      {
        toolCalls: [{
          id: "call-2",
          name: "web.build",
          arguments: { path: "site", plan: { ...plan, title: "第二版说明页", sections: [{ heading: "新小节", bullets: ["新增内容"] }] } },
        }],
      },
      { content: "第二版。" },
    ],
  });
  const secondHtml = fs.readFileSync(path.join(dir, "site", "index.html"), "utf8");
  assert.notEqual(firstHtml, secondHtml);
  assert.match(secondHtml, /第二版说明页/u);
  assert.equal(secondHtml.includes("新增内容"), true);
  const trash = fs.readdirSync(path.join(dir, ".agent-trash"));
  assert.equal(trash.length, 1, "旧版目录必须整体进入可恢复回收区");
  assert.match(trash[0], /site$/u);
  assert.equal(db.listAgentActionReceipts(OWNER, threadId).length, 2);
});

test("越界路径与指向已有文件的目录都被拒绝", async () => {
  const { dir, db, threadId } = seed();
  fs.writeFileSync(path.join(dir, "已存在文件"), "x");
  const runtime = createAgentRuntime(db);
  const model = new ScriptedModel([
    { toolCalls: [{ id: "call-1", name: "web.build", arguments: { path: "../escape", plan } }] },
    { toolCalls: [{ id: "call-2", name: "web.build", arguments: { path: "已存在文件", plan } }] },
    { content: "两次都被拒绝。" },
  ]);
  const run = await runtime.runs.start({
    ownerUserId: OWNER,
    threadId,
    history: [{ role: "user" as const, content: "做网页" }],
    workingDirectory: dir,
    intent: "做网页",
    provider: async () => ({ model, systemPrompt: "系统说明" }),
  });
  assert.equal(run.status, "completed");
  assert.equal(db.listAgentActionReceipts(OWNER, threadId).length, 0);
  assert.deepEqual(fs.readdirSync(dir).sort(), [".data", "已存在文件"]);
});

test("核查入口按 index.html 是否存在判断是否落地", async () => {
  const { dir } = seed();
  const context: AgentSkillContext = { ownerUserId: OWNER, threadId: "t-1", runId: "r-1", workingDirectory: dir };
  const action = webSkill.actions[0];
  const before = await action.reconcile!({ path: "site", plan }, context);
  assert.deepEqual(before, { landed: false, detail: "index.html 不存在" });
  await action.execute({ path: "site", plan }, context);
  const after = await action.reconcile!({ path: "site", plan }, context);
  assert.equal(after.landed, true);
  assert.match(after.detail, /index\.html 存在/u);
});
