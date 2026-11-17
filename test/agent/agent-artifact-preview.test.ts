import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VbkDatabase } from "../../src/main/infrastructure/database/database.js";
import { buildArtifactPreview, createAgentRuntime } from "../../src/main/agent-runtime/index.js";
import type { AgentModel, AgentModelInput, AgentModelResult } from "../../src/main/agent/types.js";

const OWNER = 1001;

const plan = {
  title: "预览测试页",
  description: "应用内预览用",
  sections: [{ heading: "集合与取车", body: "日喀则市城南街道吉林南路3号旅游服务中心" }],
};

class ScriptedModel implements AgentModel {
  constructor(private readonly responses: AgentModelResult[]) {}

  async complete(_input: AgentModelInput): Promise<AgentModelResult> {
    const next = this.responses.shift();
    if (!next) throw new Error("模型脚本已用尽");
    return next;
  }
}

function seed(): { dir: string; db: VbkDatabase; threadId: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vbk-artifact-preview-"));
  const db = new VbkDatabase(path.join(dir, ".data"));
  const thread = db.createAgentThread(OWNER, { workingDirectory: dir, title: "预览" });
  return { dir, db, threadId: thread.id };
}

async function buildWeb(input: { db: VbkDatabase; threadId: string; dir: string }, extra: Record<string, unknown> = {}) {
  const model = new ScriptedModel([
    { toolCalls: [{ id: "call-1", name: "web.build", arguments: { path: "site", plan, ...extra } }] },
    { content: "网页已生成。" },
  ]);
  const runtime = createAgentRuntime(input.db);
  const common = {
    ownerUserId: OWNER,
    threadId: input.threadId,
    history: [{ role: "user" as const, content: "做网页" }],
    workingDirectory: input.dir,
    provider: async () => ({ model, systemPrompt: "系统说明" }),
  };
  await runtime.runs.start({ ...common, intent: "做网页" });
  const approval = runtime.runs.snapshot({ ownerUserId: OWNER, threadId: input.threadId, workingDirectory: input.dir }).approval!;
  await runtime.runs.approve({ ...common, toolCallId: approval.toolCallId, scope: "once" });
  return input.db.listAgentActionReceipts(OWNER, input.threadId)[0];
}

test("目录产物预览：内联同目录样式，保留正文，不含残留 link", async () => {
  const { dir, db, threadId } = seed();
  const receipt = await buildWeb({ db, threadId, dir });
  const preview = await buildArtifactPreview({
    db, ownerUserId: OWNER, threadId, receiptId: receipt.id, workingDirectory: dir,
  });
  assert.equal(preview.entry, "index.html");
  assert.equal(preview.truncated, false);
  assert.match(preview.html, /<style>/u, "样式必须内联");
  assert.doesNotMatch(preview.html, /<link[^>]+stylesheet/u, "不应残留外链样式");
  assert.match(preview.html, /日喀则市城南街道吉林南路3号旅游服务中心/u);
  assert.match(preview.html, /--accent: #0d9488/u, "内联的是生成时的主题样式");
});

test("演示文稿等文件型产物不支持应用内预览，明确提示", async () => {
  const { dir, db, threadId } = seed();
  const model = new ScriptedModel([
    {
      toolCalls: [{
        id: "call-1",
        name: "deck.generate",
        arguments: { path: "汇报.pptx", plan: { title: "汇报", slides: [{ layout: "cover", title: "封面" }] } },
      }],
    },
    { content: "已生成。" },
  ]);
  const runtime = createAgentRuntime(db);
  const common = {
    ownerUserId: OWNER,
    threadId,
    history: [{ role: "user" as const, content: "做 PPT" }],
    workingDirectory: dir,
    provider: async () => ({ model, systemPrompt: "系统说明" }),
  };
  await runtime.runs.start({ ...common, intent: "做 PPT" });
  const approval = runtime.runs.snapshot({ ownerUserId: OWNER, threadId, workingDirectory: dir }).approval!;
  await runtime.runs.approve({ ...common, toolCallId: approval.toolCallId, scope: "once" });
  const receipt = db.listAgentActionReceipts(OWNER, threadId)[0];

  await assert.rejects(
    () => buildArtifactPreview({ db, ownerUserId: OWNER, threadId, receiptId: receipt.id, workingDirectory: dir }),
    /只有目录型产物/u,
  );
});

test("越出产物目录的样式引用不会被内联", async () => {
  const { dir, db, threadId } = seed();
  const receipt = await buildWeb({ db, threadId, dir });
  const outside = path.join(dir, "secret.css");
  fs.writeFileSync(outside, ":root{--secret:1}", "utf8");
  const entry = path.join(dir, "site", "index.html");
  const html = fs.readFileSync(entry, "utf8").replace('href="styles.css"', 'href="../secret.css"');
  fs.writeFileSync(entry, html, "utf8");

  const preview = await buildArtifactPreview({
    db, ownerUserId: OWNER, threadId, receiptId: receipt.id, workingDirectory: dir,
  });
  assert.doesNotMatch(preview.html, /--secret/u, "越界引用必须被丢弃");
  assert.match(preview.html, /<link[^>]+stylesheet/u, "越界引用保留原样而不是乱替换");
});

test("超大页面标记截断，避免把巨型文件送进渲染进程", async () => {
  const { dir, db, threadId } = seed();
  const receipt = await buildWeb({ db, threadId, dir });
  const entry = path.join(dir, "site", "index.html");
  fs.writeFileSync(entry, `<html><body>${"填充".repeat(300_000)}</body></html>`, "utf8");
  const preview = await buildArtifactPreview({
    db, ownerUserId: OWNER, threadId, receiptId: receipt.id, workingDirectory: dir,
  });
  assert.equal(preview.truncated, true);
  assert.ok(preview.html.length <= 512 * 1024);
});

test("预览走的是收据：跨任务或未登记产物的收据都拒绝", async () => {
  const { dir, db, threadId } = seed();
  const receipt = await buildWeb({ db, threadId, dir });
  const other = db.createAgentThread(OWNER, { workingDirectory: dir });
  await assert.rejects(
    () => buildArtifactPreview({ db, ownerUserId: OWNER, threadId: other.id, receiptId: receipt.id, workingDirectory: dir }),
    /没有这条收据/u,
  );
  await assert.rejects(
    () => buildArtifactPreview({ db, ownerUserId: OWNER, threadId, receiptId: "nope", workingDirectory: dir }),
    /没有这条收据/u,
  );
});
