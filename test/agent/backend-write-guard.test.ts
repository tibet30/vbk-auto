import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VbkDatabase } from "../../src/main/infrastructure/database/database.js";
import {
  assertBackendWritesAreVerifiable,
  createAgentRuntime,
  findBackendWriteViolations,
  isBackendSkill,
  type AgentSkill,
  type AgentSkillAction,
} from "../../src/main/agent-runtime/index.js";

function action(overrides: Partial<AgentSkillAction> & { name: string; kind: AgentSkillAction["kind"] }): AgentSkillAction {
  return {
    label: overrides.name,
    risk: "medium",
    description: "测试用动作",
    parameters: { type: "object", properties: {} },
    async target() { return { action: overrides.name, targetKey: "/x", accountKey: "vbk-test", risk: "medium" }; },
    async execute() { return { content: "ok", summary: "ok", result: "ok" }; },
    ...overrides,
  } as AgentSkillAction;
}

function backendSkill(actions: AgentSkillAction[], id = "vbk-test"): AgentSkill {
  return { id, label: "测试后台", description: "", actions };
}

test("只读动作不受后台写准入约束", () => {
  assert.deepEqual(findBackendWriteViolations([backendSkill([action({ name: "vbk.read", kind: "read" })])]), []);
  assert.doesNotThrow(() => assertBackendWritesAreVerifiable([backendSkill([action({ name: "vbk.read", kind: "read" })])]));
});

test("后台写动作缺少 preview / reconcile 时被拒绝，并说明缺什么", () => {
  const violations = findBackendWriteViolations([backendSkill([
    action({ name: "vbk.save", kind: "write" }),
    action({ name: "vbk.save2", kind: "write", preview: async () => ({ summary: "x" }) }),
  ])]);
  assert.equal(violations.length, 3, JSON.stringify(violations));
  assert.ok(violations.some((entry) => entry.action === "vbk.save" && entry.reason.includes("preview")));
  assert.ok(violations.some((entry) => entry.action === "vbk.save" && entry.reason.includes("reconcile")));
  assert.ok(violations.some((entry) => entry.action === "vbk.save2" && entry.reason.includes("reconcile")));
  assert.throws(
    () => assertBackendWritesAreVerifiable([backendSkill([action({ name: "vbk.save", kind: "write" })])]),
    /后台写动作未满足准入要求/u,
  );
});

test("同时具备 preview 与 reconcile 的后台写动作可以装配", () => {
  const compliant = action({
    name: "vbk.save",
    kind: "write",
    preview: async () => ({ summary: "保存 xxx" }),
    reconcile: async () => ({ landed: true, detail: "已回读确认" }),
  });
  assert.deepEqual(findBackendWriteViolations([backendSkill([compliant])]), []);
  assert.doesNotThrow(() => assertBackendWritesAreVerifiable([backendSkill([compliant])]));
});

test("外部 MCP 工具不受这条约束（由各自 server 负责）", () => {
  assert.equal(isBackendSkill({ id: "mcp-fixture", label: "外部", description: "", actions: [] }), false);
  const external = backendSkill([action({ name: "mcp.fixture.write", kind: "write" })], "mcp-fixture");
  assert.deepEqual(findBackendWriteViolations([external]), []);
});

test("装配运行时即触发准入：违规的后台写 Skill 无法进入运行时", () => {
  const db = new VbkDatabase(fs.mkdtempSync(path.join(os.tmpdir(), "vbk-write-guard-")));
  assert.throws(
    () => createAgentRuntime(db, {
      skills: [backendSkill([action({ name: "vbk.save", kind: "write" })])],
    }),
    /后台写动作未满足准入要求/u,
  );
  assert.doesNotThrow(() => createAgentRuntime(db, {
    skills: [backendSkill([
      action({
        name: "vbk.save",
        kind: "write",
        preview: async () => ({ summary: "保存" }),
        reconcile: async () => ({ landed: true, detail: "ok" }),
      }),
    ])],
  }));
});
