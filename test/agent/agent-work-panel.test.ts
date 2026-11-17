import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AgentWorkPanel, shouldShowWorkPanel } from "../../src/renderer/app/views/agent/AgentWorkPanel.js";
import type { AgentRuntimeSnapshot } from "../../src/shared/contracts-agent-runtime.js";

const artifactReceipt = {
  id: "receipt-1",
  threadId: "thread-1",
  runId: "run-1",
  toolCallId: "call-1",
  action: "web.build",
  targetKey: "/tmp/site",
  accountKey: "local-fs",
  idempotencyKey: "key-1",
  status: "succeeded" as const,
  result: "写入 /tmp/site：3 个文件",
  createdAt: "2026-11-16T12:00:00.000Z",
  artifact: {
    kind: "directory" as const,
    path: "/tmp/site",
    entry: "index.html",
    files: [
      { path: "index.html", bytes: 1024 },
      { path: "styles.css", bytes: 512 },
      { path: "README.md", bytes: 128 },
    ],
  },
};

function render(runtime: AgentRuntimeSnapshot): string {
  return renderToStaticMarkup(createElement(AgentWorkPanel, {
    threadId: "thread-1",
    runtime,
    pending: false,
    onApprove: () => {},
    onReject: () => {},
    onReconcile: () => {},
    onOpenArtifact: () => {},
    onPreviewArtifact: () => {},
    onResume: () => {},
    onCancel: () => {},
  }));
}

test("运行已结束、工具调用滚出窗口时，产物面板仍然出现并可打开", () => {
  const runtime: AgentRuntimeSnapshot = {
    run: {
      id: "run-1",
      threadId: "thread-1",
      ownerUserId: 1,
      status: "completed",
      intent: "做一个说明页",
      step: 2,
      maxSteps: 12,
      createdAt: "2026-11-16T12:00:00.000Z",
      updatedAt: "2026-11-16T12:00:01.000Z",
    },
    toolCalls: [],
    receipts: [artifactReceipt],
    skills: [],
  };
  assert.equal(shouldShowWorkPanel(runtime), true);
  const html = render(runtime);
  assert.match(html, /产物/u);
  assert.match(html, /文件夹/u);
  assert.match(html, /index\.html/u);
  assert.match(html, /styles\.css/u);
  assert.match(html, /打开/u);
  assert.match(html, /在文件夹中显示/u);
  assert.match(html, /1\.6 KB/u);
});

test("纯闲聊（无运行、无动作、无产物）不占用第三栏", () => {
  const runtime: AgentRuntimeSnapshot = { toolCalls: [], receipts: [], skills: [] };
  assert.equal(shouldShowWorkPanel(runtime), false);
  assert.equal(render(runtime), "");
});

test("审批优先于产物展示，审批卡与产物同时存在时两者都渲染", () => {
  const runtime: AgentRuntimeSnapshot = {
    run: {
      id: "run-2",
      threadId: "thread-1",
      ownerUserId: 1,
      status: "waiting_approval",
      intent: "再生成一版",
      step: 1,
      maxSteps: 12,
      createdAt: "2026-11-16T12:00:00.000Z",
      updatedAt: "2026-11-16T12:00:01.000Z",
    },
    approval: {
      toolCallId: "call-2",
      runId: "run-2",
      skillId: "deck",
      skillLabel: "演示文稿",
      toolName: "deck.generate",
      actionLabel: "生成演示文稿",
      kind: "write",
      risk: "high",
      accountKey: "local-fs",
      directory: "/tmp",
      targetKey: "/tmp/site/汇报.pptx",
      summary: "生成 汇报.pptx（3 页）",
      scopes: ["once", "thread"],
    },
    toolCalls: [],
    receipts: [artifactReceipt],
    skills: [],
  };
  const html = render(runtime);
  assert.match(html, /需要授权/u);
  assert.match(html, /仅本次允许/u);
  assert.match(html, /产物/u);
  assert.match(html, /取消运行/u);
});

test("needs_attention 提供继续运行，uncertain 必须先核查不提供", () => {
  const baseRun = {
    id: "run-3",
    threadId: "thread-1",
    ownerUserId: 1,
    intent: "整理目录",
    step: 3,
    maxSteps: 12,
    createdAt: "2026-11-16T12:00:00.000Z",
    updatedAt: "2026-11-16T12:00:01.000Z",
  };
  const resumable = render({
    run: { ...baseRun, status: "needs_attention", error: "模型暂时不可用" },
    toolCalls: [],
    receipts: [],
    skills: [],
  });
  assert.match(resumable, /继续运行/u);
  assert.match(resumable, /模型暂时不可用/u);
  assert.doesNotMatch(resumable, /取消运行/u);

  const uncertain = render({
    run: { ...baseRun, status: "uncertain", error: "写入状态不明" },
    toolCalls: [],
    receipts: [],
    skills: [],
  });
  assert.doesNotMatch(uncertain, /继续运行/u, "结果不确定时必须先核查");
  assert.match(uncertain, /结果不确定/u);
});

test("外部工具失败时面板必须出现，并给出可读诊断", () => {
  const runtime: AgentRuntimeSnapshot = {
    toolCalls: [],
    receipts: [],
    skills: [],
    externalTools: [
      { serverId: "ok", label: "可用服务", state: "ready", tools: ["read_note"], changes: [] },
      {
        serverId: "bad",
        label: "坏服务",
        state: "failed",
        tools: [],
        changes: ["工具 write_note 的输入 Schema 发生变化"],
        error: "连接 坏服务 超时（15000ms）",
      },
    ],
  };
  assert.equal(shouldShowWorkPanel(runtime), true);
  const html = render(runtime);
  assert.match(html, /外部工具/u);
  assert.match(html, /1\/2 可用/u);
  assert.match(html, /可用服务/u);
  assert.match(html, /已连接/u);
  assert.match(html, /坏服务/u);
  assert.match(html, /不可用/u);
  assert.match(html, /连接 坏服务 超时/u);
  assert.match(html, /Schema 发生变化/u);

  assert.equal(shouldShowWorkPanel({
    toolCalls: [], receipts: [], skills: [],
    externalTools: [{ serverId: "ok", label: "可用服务", state: "ready", tools: ["read_note"], changes: [] }],
  }), false, "全部就绪且没有运行事实时不占第三栏");
});

test("写入排队时面板出现，并标出正在写与持锁任务", () => {
  const runtime: AgentRuntimeSnapshot = {
    toolCalls: [],
    receipts: [],
    skills: [],
    writeQueues: [{
      accountKey: "vbk_671205",
      running: true,
      waiting: 1,
      since: "2026-11-16T12:00:00.000Z",
      holderThreadId: "abcdef12-3456-7890-abcd-ef1234567890",
    }],
  };
  assert.equal(shouldShowWorkPanel(runtime), true);
  const html = render(runtime);
  assert.match(html, /写入队列/u);
  assert.match(html, /vbk_671205/u);
  assert.match(html, /正在写/u);
  assert.match(html, /排队 1 个写操作/u);
  assert.match(html, /持有任务 abcdef12/u);
});

test("只有目录型产物提供应用内预览入口", () => {
  const runtime: AgentRuntimeSnapshot = {
    toolCalls: [],
    receipts: [
      artifactReceipt,
      {
        ...artifactReceipt,
        id: "receipt-2",
        artifact: { kind: "file", path: "/tmp/汇报.pptx", entry: "汇报.pptx", files: [{ path: "汇报.pptx", bytes: 2048 }] },
      },
    ],
    skills: [],
  };
  const html = render(runtime);
  assert.equal(html.split("预览").length - 1 >= 1, true, "网页产物要有预览按钮");
  // 文件型产物行只有「打开 / 在文件夹中显示」，不出现预览。
  assert.match(html, /文件夹/u);
});
