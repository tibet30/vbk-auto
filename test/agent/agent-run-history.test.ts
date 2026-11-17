import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { VbkDatabase } from "../../src/main/infrastructure/database/database.js";
import { createAgentRuntime } from "../../src/main/agent-runtime/index.js";
import { AgentWorkPanel, shouldShowWorkPanel } from "../../src/renderer/app/views/agent/AgentWorkPanel.js";
import type { AgentRuntimeSnapshot } from "../../src/shared/contracts-agent-runtime.js";

const OWNER = 1001;
const noop = () => {};

function render(runtime: AgentRuntimeSnapshot): string {
  return renderToStaticMarkup(createElement(AgentWorkPanel, {
    threadId: "t-1",
    runtime,
    pending: false,
    onApprove: noop,
    onReject: noop,
    onReconcile: noop,
    onOpenArtifact: noop,
    onPreviewArtifact: noop,
    onResume: noop,
    onCancel: noop,
  }));
}

function run(index: number, status: "completed" | "failed" | "cancelled") {
  return {
    id: `run-${index}`,
    threadId: "t-1",
    ownerUserId: OWNER,
    status,
    intent: `第 ${index} 轮任务`,
    step: index,
    maxSteps: 12,
    createdAt: `2026-11-16T12:0${index}:00.000Z`,
    updatedAt: `2026-11-16T12:0${index}:30.000Z`,
  };
}

test("快照带最近运行，最新在前且不超过上限", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vbk-run-history-"));
  const db = new VbkDatabase(path.join(dir, "data"));
  const thread = db.createAgentThread(OWNER, { title: "多轮任务" });
  for (let index = 0; index < 12; index += 1) {
    const created = db.createAgentRun(OWNER, { threadId: thread.id, intent: `第 ${index} 轮` });
    db.updateAgentRun(OWNER, created.id, { status: "completed", completedAt: new Date().toISOString() });
  }
  const runtime = createAgentRuntime(db);
  const snapshot = runtime.runs.snapshot({ ownerUserId: OWNER, threadId: thread.id });
  assert.equal(snapshot.runs?.length, 10, "上限 10 条");
  assert.equal(snapshot.runs?.[0].intent, "第 11 轮", "最新在前");
  assert.equal(snapshot.run?.intent, "第 11 轮", "顶部状态仍是最新一次");
  assert.equal(snapshot.runs?.[9].intent, "第 2 轮");
});

test("面板展示历史运行，且不重复展示当前运行", () => {
  const runtime: AgentRuntimeSnapshot = {
    run: run(3, "completed"),
    runs: [run(3, "completed"), run(2, "failed"), run(1, "cancelled")],
    toolCalls: [],
    receipts: [],
    skills: [],
  };
  assert.equal(shouldShowWorkPanel(runtime), true, "多轮任务即使没有动作也要能看到历史");
  const html = render(runtime);
  assert.match(html, /历史运行/u);
  assert.match(html, /最近 2 次/u);
  assert.match(html, /第 2 轮任务/u);
  assert.match(html, /第 1 轮任务/u);
  // 当前运行的意图只应出现在顶部状态里一次，不应在历史区块里重复。
  assert.equal(html.split("第 3 轮任务").length - 1, 1, "当前运行由顶部状态承担，不在历史里重复");
  assert.match(html, /已完成|失败|已取消/u);
});

test("仅一次运行时不显示历史区块", () => {
  const runtime: AgentRuntimeSnapshot = {
    run: run(1, "completed"),
    runs: [run(1, "completed")],
    toolCalls: [],
    receipts: [],
    skills: [],
  };
  const html = render(runtime);
  assert.equal(html.includes("历史运行"), false);
});
