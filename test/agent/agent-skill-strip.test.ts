import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AgentThreadView } from "../../src/renderer/app/views/agent/AgentThreadView.js";
import type { AgentThreadWorkspace } from "../../src/shared/contracts-agent-runtime.js";

const noop = () => {};

function render(detail: AgentThreadWorkspace): string {
  return renderToStaticMarkup(createElement(AgentThreadView, {
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
}

function workspace(enabledSkills?: string[]): AgentThreadWorkspace {
  return {
    thread: {
      id: "t-1",
      ownerUserId: 1,
      title: "整理文件",
      status: "waiting",
      pinned: false,
      messageCount: 1,
      createdAt: "2026-11-16T12:00:00.000Z",
      updatedAt: "2026-11-16T12:00:00.000Z",
    },
    messages: [],
    runtime: {
      toolCalls: [],
      receipts: [],
      skills: [
        { id: "local-file", label: "本地文件", description: "读写目录", actions: [] },
        { id: "deck", label: "演示文稿", description: "生成 PPT", actions: [] },
      ],
      ...(enabledSkills !== undefined ? { enabledSkills } : {}),
    },
  };
}

test("Skill 条默认全部启用，不显示停用提示", () => {
  const html = render(workspace());
  assert.match(html, /本地文件/u);
  assert.match(html, /演示文稿/u);
  assert.doesNotMatch(html, /已停用部分能力/u);
  assert.match(html, /aria-pressed="true"/u);
});

test("停用某个 Skill 后按钮状态变化并给出提示", () => {
  const html = render(workspace(["deck"]));
  assert.match(html, /已停用部分能力/u);
  assert.match(html, /aria-pressed="false"/u, "被停用的 Skill 必须显示为未启用");
  assert.match(html, /aria-pressed="true"/u);
});
