import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { renderAssistantMarkdown } from "../../src/renderer/app/views/workspace/assistant-markdown.js";

test("助手 Markdown 渲染 GFM 表格，而不是普通段落", () => {
  const markdown = [
    "# 本地规划完成报告",
    "",
    "已完成（本地）：",
    "",
    "| 模块 | 状态 | 内容 |",
    "|---|---|---|",
    "| basicInfo | ✅ | 日喀则2天1晚，meetingCity=destinationCity=日喀则 |",
    "| itinerary | ✅ | 2 天 5 个真实 POI |",
  ].join("\n");

  const html = renderToStaticMarkup(renderAssistantMarkdown(markdown));

  assert.match(html, /<table>/);
  assert.match(html, /<thead><tr><th>模块<\/th><th>状态<\/th><th>内容<\/th><\/tr><\/thead>/);
  assert.match(html, /<td>basicInfo<\/td><td>✅<\/td>/);
  assert.doesNotMatch(html, /\| 模块 \| 状态 \| 内容 \|/);
});

test("多行行首强调文本有独立 React key，不重复写入运行时错误", () => {
  const original = console.error;
  const errors: unknown[][] = [];
  console.error = (...args: unknown[]) => { errors.push(args); };
  try {
    renderToStaticMarkup(renderAssistantMarkdown("**第一行**\n**第二行**"));
  } finally {
    console.error = original;
  }
  assert.equal(errors.length, 0);
});
