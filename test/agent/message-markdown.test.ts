import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MessageMarkdown } from "../../src/renderer/app/views/shared/message-markdown.js";
import { AgentThreadView } from "../../src/renderer/app/views/agent/AgentThreadView.js";
import type { AgentThreadWorkspace } from "../../src/shared/contracts-agent-runtime.js";

const noop = () => {};

function render(content: string): string {
  return renderToStaticMarkup(createElement(MessageMarkdown, { content }));
}

/** 截图里的那类回答：二级标题 + 汇总句 + GFM 表格 + 有序列表 + 条目列表。 */
const ORDER_REPORT = [
  "## 结论",
  "",
  "共 4 笔客户订单，合计 **¥2,331**（3 笔待支付 + 1 笔已取消）。",
  "",
  "**按状态分组：**",
  "",
  "| 状态 | 订单号 | 金额 |",
  "|---|---|---|",
  "| 待支付 | 223016566171929308 | ¥511 |",
  "| 已取消 | 949732159312931811 | ¥300 |",
  "",
  "**按金额排序（从高到低）：**",
  "",
  "1. ¥1000 — 待支付 — 订单 819433286508307182",
  "2. ¥520 — 待支付 — 订单 446719581584434143",
  "",
  "- 全部订单均为 2 人出行",
].join("\n");

test("助手 Markdown 渲染标题、加粗、GFM 表格与列表，而不是原样输出标记", () => {
  const html = render(ORDER_REPORT);

  assert.match(html, /<h2>结论<\/h2>/u);
  assert.match(html, /<strong>¥2,331<\/strong>/u);
  assert.match(html, /<table>/u);
  assert.match(html, /<th>状态<\/th><th>订单号<\/th><th>金额<\/th>/u);
  assert.match(html, /<td>待支付<\/td><td>223016566171929308<\/td>/u);
  assert.match(html, /<ol>/u);
  assert.match(html, /<ul>/u);

  assert.doesNotMatch(html, /## 结论/u, "标题标记不能出现在正文里");
  assert.doesNotMatch(html, /\*\*¥2,331\*\*/u, "加粗标记不能出现在正文里");
  assert.doesNotMatch(html, /\| 状态 \| 订单号 \| 金额 \|/u, "表格管道符不能出现在正文里");
  assert.doesNotMatch(html, /^1\. ¥1000/mu, "有序列表标记不能出现在正文里");
});

test("表格包在横向滚动容器里，宽表不会撑破面板", () => {
  const html = render(ORDER_REPORT);
  assert.match(html, /<div class="[^"]*"><table>/u, "表格必须包一层滚动容器");
});

test("单换行按换行渲染，代码块走 pre/code", () => {
  assert.match(render("**第一行**\n**第二行**"), /<strong>第一行<\/strong><br\/>\s*<strong>第二行<\/strong>/u);
  assert.match(render("```\nconst a = 1;\n```"), /<pre><code>const a = 1;\n<\/code><\/pre>/u);
});

test("外链在新窗口打开，脚本协议不会被输出成 href", () => {
  const html = render("[平台](https://vbooking.ctrip.com/product)");
  assert.match(html, /href="https:\/\/vbooking\.ctrip\.com\/product"/u);
  assert.match(html, /target="_blank"/u);
  assert.match(html, /rel="noreferrer noopener"/u);
  assert.doesNotMatch(render("[点我](javascript:alert(1))"), /javascript:/u);
});

test("多行行首强调文本不产生运行时错误", () => {
  const original = console.error;
  const errors: unknown[][] = [];
  console.error = (...args: unknown[]) => { errors.push(args); };
  try {
    render("**第一行**\n**第二行**");
  } finally {
    console.error = original;
  }
  assert.equal(errors.length, 0);
});

test("智能体消息正文走 Markdown 渲染，用户消息保持原文", () => {
  const detail: AgentThreadWorkspace = {
    thread: {
      id: "t-1",
      ownerUserId: 1,
      title: "查订单",
      status: "waiting",
      pinned: false,
      messageCount: 2,
      createdAt: "2026-11-18T12:00:00.000Z",
      updatedAt: "2026-11-18T12:00:00.000Z",
    },
    messages: [
      { id: "m-1", threadId: "t-1", role: "assistant", content: "## 结论\n\n合计 **¥2,331**", createdAt: "2026-11-18T12:00:01.000Z" },
      { id: "m-2", threadId: "t-1", role: "user", content: "按 **状态** 列出来", createdAt: "2026-11-18T12:00:02.000Z" },
    ],
    runtime: { toolCalls: [], receipts: [], skills: [] },
  };
  const html = renderToStaticMarkup(createElement(AgentThreadView, {
    detail,
    sending: false,
    pending: false,
    onSend: noop,
    onSelectDirectory: noop,
    onApprove: noop,
    onReject: noop,
    onReconcile: noop,
    onOpenArtifact: noop,
    onToggleSkill: noop,
    onResume: noop,
    onCancel: noop,
  }));

  assert.match(html, /<h2>结论<\/h2>/u);
  assert.match(html, /<strong>¥2,331<\/strong>/u);
  assert.doesNotMatch(html, /## 结论/u);
  assert.match(html, /按 \*\*状态\*\* 列出来/u, "用户输入必须原样显示");
});
