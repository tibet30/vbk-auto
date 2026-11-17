import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { VbkDatabase } from "../../src/main/infrastructure/database/database.js";
import { AgentWorkspaceService } from "../../src/main/agent-workspace/service.js";
import { AgentThreadView } from "../../src/renderer/app/views/agent/AgentThreadView.js";
import type { MainIpcContext } from "../../src/main/ipc/context.js";
import type { AgentThreadWorkspace } from "../../src/shared/contracts-agent-runtime.js";

const OWNER = 1001;
const noop = () => {};

function service(db: VbkDatabase): AgentWorkspaceService {
  return new AgentWorkspaceService({
    db,
    getExtensionUserId: () => OWNER,
  } as unknown as MainIpcContext);
}

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

function workspace(directory: string | undefined, available: boolean | undefined): AgentThreadWorkspace {
  return {
    thread: {
      id: "t-1",
      ownerUserId: OWNER,
      title: "整理文件",
      status: "waiting",
      pinned: false,
      ...(directory ? { workingDirectory: directory } : {}),
      messageCount: 0,
      createdAt: "2026-11-16T12:00:00.000Z",
      updatedAt: "2026-11-16T12:00:00.000Z",
    },
    messages: [],
    runtime: { toolCalls: [], receipts: [], skills: [] },
    ...(available !== undefined ? { workingDirectoryAvailable: available } : {}),
  };
}

test("任务目录可用性：未选目录不判定，存在为 true，不存在为 false", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vbk-dir-health-"));
  const db = new VbkDatabase(path.join(dir, ".data"));
  const api = service(db);

  const none = api.create({ title: "无目录" });
  assert.equal(api.get(none.id).workingDirectoryAvailable, undefined);

  const existing = path.join(dir, "workspace");
  fs.mkdirSync(existing);
  const ok = api.create({ title: "有目录", workingDirectory: existing });
  assert.equal(api.get(ok.id).workingDirectoryAvailable, true);

  const missing = api.create({ title: "目录没了", workingDirectory: path.join(dir, "gone") });
  assert.equal(api.get(missing.id).workingDirectoryAvailable, false);
});

test("目录不可用时界面提前提示，而不是等模型报错", () => {
  const missing = render(workspace("/tmp/vbk-gone-dir", false));
  assert.match(missing, /目录不可用/u);
  assert.match(missing, /vbk-gone-dir/u);

  const healthy = render(workspace("/tmp/vbk-agent-smoke", true));
  assert.doesNotMatch(healthy, /目录不可用/u);
});
