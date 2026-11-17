import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VbkDatabase } from "../../src/main/infrastructure/database/database.js";
import { createAgentRuntime, resolveArtifactForOpen } from "../../src/main/agent-runtime/index.js";
import type { AgentModel, AgentModelInput, AgentModelResult } from "../../src/main/agent/types.js";

const OWNER = 1001;

const plan = {
  title: "产物说明页",
  sections: [{ heading: "集合", body: "日喀则市城南街道吉林南路3号旅游服务中心" }],
};

class ScriptedModel implements AgentModel {
  constructor(private readonly responses: AgentModelResult[]) {}

  async complete(_input: AgentModelInput): Promise<AgentModelResult> {
    const next = this.responses.shift();
    if (!next) throw new Error("模型脚本已用尽");
    return next;
  }
}

function seed(): { base: string; dir: string; db: VbkDatabase; threadId: string } {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "vbk-artifact-"));
  const dir = path.join(base, "workspace");
  fs.mkdirSync(dir);
  const db = new VbkDatabase(path.join(base, ".data"));
  const thread = db.createAgentThread(OWNER, { workingDirectory: dir });
  return { base, dir, db, threadId: thread.id };
}

async function buildWeb(input: { db: VbkDatabase; threadId: string; dir: string }): Promise<void> {
  const model = new ScriptedModel([
    { toolCalls: [{ id: "call-1", name: "web.build", arguments: { path: "site", plan } }] },
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
}

test("产物元数据随收据落库，并解析出可打开的预览入口", async () => {
  const { dir, db, threadId } = seed();
  await buildWeb({ db, threadId, dir });

  const receipt = db.listAgentActionReceipts(OWNER, threadId)[0];
  assert.equal(receipt.status, "succeeded");
  assert.equal(receipt.artifact?.kind, "directory");
  assert.equal(receipt.artifact?.entry, "index.html");
  assert.deepEqual(receipt.artifact?.files.map((file) => file.path).sort(), ["README.md", "index.html", "styles.css"]);
  assert.ok((receipt.artifact?.files.every((file) => file.bytes > 0)));

  const resolved = await resolveArtifactForOpen({ db, ownerUserId: OWNER, threadId, receiptId: receipt.id, workingDirectory: dir });
  // macOS 上 /var 是 /private/var 的软链接，比较前统一取 realpath。
  const realDir = fs.realpathSync(dir);
  assert.equal(resolved.openPath, path.join(realDir, "site", "index.html"));
  assert.equal(resolved.absolute, path.join(realDir, "site"));
});

test("演示文稿产物是单个可编辑文件，入口就是文件本身", async () => {
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
  assert.equal(receipt.artifact?.kind, "file");
  assert.equal(receipt.artifact?.files.length, 1);
  const resolved = await resolveArtifactForOpen({ db, ownerUserId: OWNER, threadId, receiptId: receipt.id, workingDirectory: dir });
  assert.equal(resolved.openPath, path.join(fs.realpathSync(dir), "汇报.pptx"));
});

test("只认本任务的成功收据：未知收据、跨任务、无产物、越界路径都拒绝", async () => {
  const { base, dir, db, threadId } = seed();
  const other = db.createAgentThread(OWNER, { workingDirectory: dir });

  const missing = db.saveAgentActionReceipt(OWNER, {
    threadId, runId: "run-x", toolCallId: "call-x", action: "file.read",
    targetKey: path.join(dir, "a.md"), accountKey: "local-fs",
    idempotencyKey: "artifact-1", status: "succeeded", result: "ok",
  });
  assert.equal(missing.receipt.artifact, undefined);
  await assert.rejects(
    () => resolveArtifactForOpen({ db, ownerUserId: OWNER, threadId, receiptId: missing.receipt.id, workingDirectory: dir }),
    /没有登记产物/u,
  );
  await assert.rejects(
    () => resolveArtifactForOpen({ db, ownerUserId: OWNER, threadId, receiptId: "not-exists", workingDirectory: dir }),
    /没有这条收据/u,
  );
  await assert.rejects(
    () => resolveArtifactForOpen({ db, ownerUserId: OWNER, threadId: other.id, receiptId: missing.receipt.id, workingDirectory: dir }),
    /没有这条收据/u,
  );

  // 伪造一条把产物指向授权目录之外的收据（模拟数据被篡改或历史遗留）。
  const outside = path.join(base, "outside.txt");
  fs.writeFileSync(outside, "外部文件");
  const escaped = db.saveAgentActionReceipt(OWNER, {
    threadId, runId: "run-x", toolCallId: "call-y", action: "file.create",
    targetKey: outside, accountKey: "local-fs",
    idempotencyKey: "artifact-2", status: "succeeded", result: "写入",
    artifact: { kind: "file", path: outside, files: [{ path: "outside.txt", bytes: 12 }] },
  });
  await assert.rejects(
    () => resolveArtifactForOpen({ db, ownerUserId: OWNER, threadId, receiptId: escaped.receipt.id, workingDirectory: dir }),
    /不在当前任务的授权目录内/u,
  );
});

test("产物被删除或任务换目录后无法打开", async () => {
  const { dir, db, threadId } = seed();
  await buildWeb({ db, threadId, dir });
  const receipt = db.listAgentActionReceipts(OWNER, threadId)[0];

  fs.rmSync(path.join(dir, "site"), { recursive: true, force: true });
  await assert.rejects(
    () => resolveArtifactForOpen({ db, ownerUserId: OWNER, threadId, receiptId: receipt.id, workingDirectory: dir }),
    /已不存在/u,
  );

  const otherDir = fs.mkdtempSync(path.join(os.tmpdir(), "vbk-artifact-other-"));
  await assert.rejects(
    () => resolveArtifactForOpen({ db, ownerUserId: OWNER, threadId, receiptId: receipt.id, workingDirectory: otherDir }),
    /不在当前任务的授权目录内/u,
  );
});
