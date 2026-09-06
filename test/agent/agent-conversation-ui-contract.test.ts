import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

test("方案对话采用 Cursor 式连续线程：正文优先，思考与工具收成活动摘要", () => {
  const conversation = read("src/renderer/app/views/workspace/agent-conversation.tsx");
  const items = read("src/renderer/app/views/workspace/agent-conversation-items.tsx");
  assert.match(conversation, /item\.kind === "assistant_thread"/);
  assert.match(items, /AgentAssistantThread/);
  assert.match(items, /思考片刻/);
  assert.match(items, /已使用/);
  assert.match(items, /个工具/);
  assert.doesNotMatch(items, /AI 分析/);
  assert.doesNotMatch(items, /分析内容/);
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

test("查询景点、交通与完善模块摘要会带上具体目标", () => {
  const items = read("src/renderer/app/views/workspace/agent-conversation-items.tsx");
  assert.match(items, /function toolCallLabel/);
  assert.match(items, /query_poi/);
  assert.match(items, /query_station/);
  assert.match(items, /generate_product_module/);
  assert.match(items, /MODULE_STAGE_NAMES/);
  assert.match(items, /查询机场/);
  assert.match(items, /查询火车站/);
  assert.match(items, /每日行程/);
  assert.match(items, /\$\{base\} · \$\{keyword\}/);
  assert.match(items, /\$\{kindLabel\} · \$\{keyword\}/);
  assert.match(items, /\$\{base\} · \$\{stageLabel\}/);
});

test("运行中在状态栏和输入区都提供暂停执行入口", () => {
  const conversation = read("src/renderer/app/views/workspace/agent-conversation.tsx");
  assert.equal([...conversation.matchAll(/暂停执行/g)].length >= 2, true);
  assert.match(conversation, /styles\.pauseAction/);
  assert.match(conversation, /agent\.pause\(product\.id\)/);
  assert.match(conversation, /继续执行/);
});
