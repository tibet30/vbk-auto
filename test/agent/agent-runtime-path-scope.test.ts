import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  AgentPathScopeError,
  localFileSkill,
  requireScopedPath,
  resolveScopedPath,
  type AgentSkillContext,
} from "../../src/main/agent-runtime/index.js";

function sandbox(): { root: string; outside: string } {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "vbk-agent-scope-"));
  const root = path.join(base, "root");
  const outside = path.join(base, "outside");
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, "secret.txt"), "不可见内容");
  return { root, outside };
}

function codeOf(error: unknown): string {
  assert.ok(error instanceof AgentPathScopeError, `应抛出 AgentPathScopeError，实际：${String(error)}`);
  return error.code;
}

test("授权目录内可解析、可读取，未创建目标也能解析出父目录", async () => {
  const { root } = sandbox();
  fs.mkdirSync(path.join(root, "sub"), { recursive: true });
  fs.writeFileSync(path.join(root, "sub", "note.txt"), "内容");

  const existing = await requireScopedPath(root, "sub/note.txt");
  assert.equal(existing.relative, path.join("sub", "note.txt"));
  assert.equal(existing.exists, true);

  const future = await resolveScopedPath(root, "sub/new/deep.md");
  assert.equal(future.exists, false);
  assert.equal(path.basename(future.root), "root");
});

test("绝对路径与 .. 越界一律拒绝", async () => {
  const { root, outside } = sandbox();
  await assert.rejects(
    () => resolveScopedPath(root, path.join(outside, "secret.txt")),
    (error: unknown) => codeOf(error) === "absolute_target",
  );
  await assert.rejects(
    () => resolveScopedPath(root, "../outside/secret.txt"),
    (error: unknown) => codeOf(error) === "outside_root",
  );
  await assert.rejects(
    () => resolveScopedPath(root, "sub/../../outside/secret.txt"),
    (error: unknown) => codeOf(error) === "outside_root",
  );
});

test("软链接不得成为越界通道", async () => {
  const { root, outside } = sandbox();
  const linkFile = path.join(root, "link.txt");
  const linkDir = path.join(root, "linkdir");
  fs.symlinkSync(path.join(outside, "secret.txt"), linkFile);
  fs.symlinkSync(outside, linkDir);

  await assert.rejects(
    () => requireScopedPath(root, "link.txt"),
    (error: unknown) => codeOf(error) === "symlink_escape",
  );
  await assert.rejects(
    () => resolveScopedPath(root, "linkdir/secret.txt"),
    (error: unknown) => codeOf(error) === "symlink_escape",
  );
});

test("未授权目录与不存在的授权目录都直接失败", async () => {
  const { root } = sandbox();
  await assert.rejects(
    () => resolveScopedPath(undefined, "a.txt"),
    (error: unknown) => codeOf(error) === "missing_root",
  );
  await assert.rejects(
    () => resolveScopedPath(path.join(root, "not-exists"), "a.txt"),
    (error: unknown) => codeOf(error) === "missing_root",
  );
});

test("Skill 动作的 target() 复用同一套越界校验，越界时不会降级执行", async () => {
  const { root } = sandbox();
  const context: AgentSkillContext = { ownerUserId: 1, threadId: "t-1", runId: "r-1", workingDirectory: root };
  const read = localFileSkill.actions.find((action) => action.name === "file.read")!;
  await assert.rejects(
    () => read.target({ path: "../outside/secret.txt" }, context),
    (error: unknown) => codeOf(error) === "outside_root",
  );
  await assert.rejects(
    () => read.target({ path: "/etc/hosts" }, context),
    (error: unknown) => codeOf(error) === "absolute_target",
  );
  const inside = await read.target({ path: "." }, context);
  assert.equal(inside.accountKey, "local-fs");
  assert.equal(inside.action, "file.read");
});
