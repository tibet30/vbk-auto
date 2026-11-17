import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AgentToolsBlock } from "../../src/renderer/app/views/settings/agent-tools-block.js";

test("设置页外部工具卡片说明只读/写入边界，且不提供放宽权限的入口", () => {
  const html = renderToStaticMarkup(createElement(AgentToolsBlock));
  assert.match(html, /外部工具（MCP）/u);
  assert.match(html, /只读工具直接可用，写入工具仍要逐次授权/u);
  assert.match(html, /添加服务/u);
  assert.match(html, /重新连接/u);
  assert.match(html, /保存并应用/u);
  assert.doesNotMatch(html, /跳过授权|免审批|自动批准/u);
});
