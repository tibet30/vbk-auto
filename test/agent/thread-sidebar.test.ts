import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import * as ReactRuntime from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AgentThread } from "../../src/shared/contracts-agent-workspace.js";
import { ThreadSidebar } from "../../src/renderer/app/views/agent/ThreadSidebar.js";
import { relativeThreadTime } from "../../src/renderer/app/views/agent/thread-time.js";

(globalThis as unknown as { React: typeof ReactRuntime }).React = ReactRuntime;

const NOW = Date.parse("2026-11-19T12:00:00.000Z");

function thread(patch: Partial<AgentThread> = {}): AgentThread {
  return {
    id: "thread-1",
    ownerUserId: 1001,
    title: "用三人同游平台查一下我的客户订单",
    status: "waiting",
    pinned: false,
    unread: false,
    messageCount: 2,
    createdAt: "2026-11-19T08:00:00.000Z",
    updatedAt: "2026-11-19T09:00:00.000Z",
    ...patch,
  };
}

function render(threads: AgentThread[]): string {
  return renderToStaticMarkup(createElement(ThreadSidebar, {
    threads,
    query: "",
    onQueryChange: () => {},
    onNew: () => {},
    onOpen: () => {},
    onUpdate: () => {},
    onDelete: () => {},
  }));
}

test("列表不再展示等待继续状态", () => {
  const html = render([thread({ status: "waiting" })]);
  assert.doesNotMatch(html, /等待继续/);
});

test("等待继续的任务没有可展示的状态文案", () => {
  const html = render([thread({ status: "waiting" })]);
  assert.doesNotMatch(html, /threadStatus/);
});

test("未读任务在最右渲染绿点，已读任务不渲染", () => {
  const unreadHtml = render([thread({ unread: true })]);
  const readHtml = render([thread({ unread: false })]);
  assert.match(unreadHtml, /aria-label="未读"/);
  assert.doesNotMatch(readHtml, /aria-label="未读"/);
  assert.ok(unreadHtml.lastIndexOf("未读") > unreadHtml.lastIndexOf("归档任务"));
});

test("列表去掉最左侧状态圆点，标题区只有一行", () => {
  const html = render([thread({ status: "needs_attention", unread: true })]);
  assert.doesNotMatch(html, /data-status/);
  assert.match(html, /用三人同游平台查一下我的客户订单/);
});

test("未 hover 展示距现在多久，hover 内容里保留当前状态", () => {
  const updatedAt = new Date(Date.now() - 3.5 * 3_600_000).toISOString();
  const html = render([thread({ status: "needs_attention", updatedAt })]);
  assert.match(html, /3 小时前/);
  assert.match(html, /需要处理/);
});

test("最近任务默认最多渲染 20 条并给出加载更多入口", () => {
  const threads = Array.from({ length: 25 }, (_, index) => thread({ id: `bulk-${index}`, title: `任务 ${index + 1}` }));
  const html = render(threads);
  assert.equal(html.match(/data-active="/g)?.length, 20);
  assert.match(html, /加载更多/);
  assert.doesNotMatch(html, /任务 21/);
});

test("任务行保留置顶和归档，去掉重命名，增加删除", () => {
  const html = render([thread()]);
  assert.match(html, /aria-label="删除任务"/);
  assert.match(html, /aria-label="置顶"/);
  assert.match(html, /aria-label="归档任务"/);
  assert.doesNotMatch(html, /重命名/);
});

test("已归档任务同样可以删除", () => {
  const html = render([thread({ status: "archived" })]);
  assert.match(html, /aria-label="删除任务"/);
  assert.match(html, /aria-label="恢复任务"/);
});

test("搜索命中超过 20 条时仍受首屏 20 条上限约束", () => {
  const threads = Array.from({ length: 24 }, (_, index) => thread({ id: `q-${index}`, title: `报价任务 ${index + 1}` }));
  const html = renderToStaticMarkup(createElement(ThreadSidebar, {
    threads,
    query: "报价",
    onQueryChange: () => {},
    onNew: () => {},
    onOpen: () => {},
    onUpdate: () => {},
    onDelete: () => {},
  }));
  assert.equal(html.match(/data-active="/g)?.length, 20);
  assert.match(html, /加载更多/);
});

test("相对时间按分钟、小时、天分档", () => {
  assert.equal(relativeThreadTime("2026-11-19T11:59:30.000Z", NOW), "刚刚");
  assert.equal(relativeThreadTime("2026-11-19T11:20:00.000Z", NOW), "40 分钟前");
  assert.equal(relativeThreadTime("2026-11-19T09:00:00.000Z", NOW), "3 小时前");
  assert.equal(relativeThreadTime("2026-11-16T12:00:00.000Z", NOW), "3 天前");
  assert.equal(relativeThreadTime("", NOW), "");
});
