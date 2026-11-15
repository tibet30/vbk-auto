import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import * as ReactRuntime from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * 根 tsconfig 不包含渲染层源码，tsx 加载渲染层 tsx 文件时会回落到经典 JSX
 * 运行时（产物引用 `React.createElement`）。生产构建由 Vite 使用自动运行时，
 * 所以这里只为测试补一个全局引用，不改生产代码。
 */
(globalThis as unknown as { React: typeof ReactRuntime }).React = ReactRuntime;
import type { AgentEvent } from "../../src/shared/contracts.js";
import { AgentAssistantThread, AgentEventItem } from "../../src/renderer/app/views/workspace/agent-conversation-items.js";
import { ToolResultBody } from "../../src/renderer/app/views/workspace/agent-conversation/index.js";
import { toolCallLabel } from "../../src/renderer/app/views/workspace/agent-conversation/labels.js";
import type { AgentThreadStep } from "../../src/renderer/app/views/workspace/agent-conversation-grouping.js";

const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

let seq = 0;
function event(type: AgentEvent["type"], content: string, data?: Record<string, unknown>): AgentEvent {
  seq += 1;
  return { id: `evt_${seq}`, runId: "run_1", type, content, createdAt: "2026-11-15T12:00:00.000Z", ...(data ? { data } : {}) };
}

const POI_RESULT = JSON.stringify({
  keyword: "故宫",
  scope: { day: 1, spotName: "故宫" },
  candidates: [
    { poiName: "故宫博物院", poiId: 1001, city: "北京", usable: true, selectable: true, availabilityStatus: "available" },
    { poiName: "沈阳故宫", poiId: 1002, city: "沈阳", usable: false, selectable: false, availabilityStatus: "available", availabilityReason: "地域不符" },
  ],
});

test("用户消息只显示首字头像与正文", () => {
  const html = renderToStaticMarkup(createElement(AgentEventItem, {
    event: event("user", "帮我做一个成都四天三晚"),
    events: [],
    userName: "张三",
  }));
  assert.match(html, /data-role="user"/);
  assert.match(html, />张</);
  assert.match(html, /帮我做一个成都四天三晚/);
});

test("助手线程把思考、正文与工具批串成一段", () => {
  const turn = event("assistant", "<think>先看行程</think>先查景点再绑定。", { modelTurnId: "t1" });
  const call = event("tool_call", "query_poi", {
    toolCallId: "c1", name: "query_poi", arguments: { keyword: "故宫" }, modelTurnId: "t1", index: 0, count: 1,
  });
  const result = event("tool_result", POI_RESULT, { toolCallId: "c1" });
  const steps: AgentThreadStep[] = [
    { kind: "turn", event: turn },
    { kind: "methods", id: "t1", events: [call] },
  ];
  const html = renderToStaticMarkup(createElement(AgentAssistantThread, { steps, events: [turn, call, result] }));
  assert.match(html, /思考片刻/);
  assert.match(html, /先查景点再绑定。/);
  assert.doesNotMatch(html, /<think/);
  assert.match(html, /已使用 1 个工具/);
  assert.match(html, /查询景点 · 故宫/);
  assert.match(html, /故宫博物院/);
  assert.match(html, /可绑定/);
});

test("景点查询结果渲染为候选卡片而不是原始 JSON", () => {
  const html = renderToStaticMarkup(createElement(ToolResultBody, { name: "query_poi", content: POI_RESULT }));
  assert.match(html, /景点检索 · 故宫/);
  assert.match(html, /2 个候选/);
  assert.match(html, /第 1 天 · 故宫/);
  assert.match(html, /沈阳故宫/);
  assert.match(html, /地域不符/);
  assert.doesNotMatch(html, /\{&quot;keyword/);
});

test("酒店规则结果渲染为钻级标签", () => {
  const html = renderToStaticMarkup(createElement(ToolResultBody, {
    name: "resolve_itinerary_hotels",
    content: JSON.stringify({
      persisted: true,
      rules: { autoMatch: true, grades: [3, 4, 5] },
      persistenceNote: "平台酒店规则已保存，无需查询或指定具体酒店",
    }),
  }));
  assert.match(html, /平台自动匹配酒店/);
  assert.match(html, /三钻/);
  assert.match(html, /四钻/);
  assert.match(html, /五钻/);
  assert.match(html, /已保存/);
});

test("工具失败与未知结构分别降级到错误条与原始数据", () => {
  const failure = renderToStaticMarkup(createElement(ToolResultBody, {
    name: "query_poi",
    content: "工具失败：查询超时\n工具：query_poi\n请判断是否再试一次。",
  }));
  assert.match(failure, /查询超时/);

  const fallback = renderToStaticMarkup(createElement(ToolResultBody, {
    name: "some_new_tool",
    content: JSON.stringify({ value: 1 }),
  }));
  assert.match(fallback, /查看原始数据/);
});

test("工具摘要带上具体查询目标", () => {
  assert.equal(toolCallLabel(event("tool_call", "query_poi", { name: "query_poi", arguments: { keyword: "故宫" } })), "查询景点 · 故宫");
  assert.equal(toolCallLabel(event("tool_call", "query_station", { name: "query_station", arguments: { keyword: "双流", kind: "airport" } })), "查询机场 · 双流");
  assert.equal(toolCallLabel(event("tool_call", "generate_product_module", { name: "generate_product_module", arguments: { stage: "itinerary" } })), "完善产品模块 · 每日行程");
});

test("方案对话采用阶段容器：持续过程与阶段总结内联", () => {
  const conversation = read("src/renderer/app/views/workspace/agent-conversation.tsx");
  const stages = read("src/renderer/app/views/workspace/agent-stage-timeline.tsx");
  const less = read("src/renderer/app/views/workspace/agent-conversation.module.less");
  assert.match(conversation, /AgentStageTimeline/);
  assert.match(stages, /item\.kind === 'assistant_thread'/);
  assert.match(stages, /任务最终总结/);
  assert.match(stages, /查看本阶段全部过程/);
  assert.match(stages, /active && children/);
  assert.match(less, /\.activity > summary\s*\{[^}]*display:\s*inline-flex/);
  assert.match(less, /\.activity > summary::after\s*\{[^}]*font-size:\s*16px/);
  assert.match(less, /\.activity\[open\] > summary::after/);
  assert.doesNotMatch(conversation, /历史沟通记录/);
});

test("创建简报作为普通沟通消息展示", () => {
  const conversation = read("src/renderer/app/views/workspace/agent-conversation.tsx");
  const less = read("src/renderer/app/views/workspace/agent-conversation.module.less");
  assert.match(conversation, /parseProductBriefMessage/);
  assert.match(conversation, /briefFields/);
  assert.match(less, /data-brief='true'/);
  assert.match(less, /\.briefFields dd[\s\S]*text-align:\s*right/);
});

test("运行中在状态栏和输入区都提供暂停执行入口", () => {
  const conversation = read("src/renderer/app/views/workspace/agent-conversation.tsx");
  assert.equal([...conversation.matchAll(/暂停执行/g)].length >= 2, true);
  assert.match(conversation, /styles\.pauseAction/);
  assert.match(conversation, /agent\.pause\(product\.id\)/);
  assert.match(conversation, /继续执行/);
});

test("最终确认按钮在本地方案未就绪时不可点", () => {
  const conversation = read("src/renderer/app/views/workspace/agent-conversation.tsx");
  assert.match(conversation, /确认方案并录入 VBK/);
  assert.match(conversation, /disabled=\{busy \|\| !readiness\.ready\}/);
  assert.match(conversation, /本地方案尚未准备完成，不能录入/);
});
