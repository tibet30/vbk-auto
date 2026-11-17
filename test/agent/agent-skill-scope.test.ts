import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VbkDatabase } from "../../src/main/infrastructure/database/database.js";
import {
  AgentSkillRegistry,
  createAgentRuntime,
  registryForScope,
  scopeSkills,
} from "../../src/main/agent-runtime/index.js";
import type { AgentModel, AgentModelInput, AgentModelResult } from "../../src/main/agent/types.js";

const OWNER = 1001;

function seed(): { dir: string; db: VbkDatabase; threadId: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vbk-skill-scope-"));
  const db = new VbkDatabase(path.join(dir, ".data"));
  const thread = db.createAgentThread(OWNER, { workingDirectory: dir, title: "Skill 作用域" });
  return { dir, db, threadId: thread.id };
}

class ScriptedModel implements AgentModel {
  readonly inputs: AgentModelInput[] = [];
  constructor(private readonly responses: AgentModelResult[]) {}

  async complete(input: AgentModelInput): Promise<AgentModelResult> {
    this.inputs.push(input);
    const next = this.responses.shift();
    if (!next) throw new Error("模型脚本已用尽");
    return next;
  }
}

test("scopeSkills：未设置=全启用，空数组=全停用，未知 id 忽略", () => {
  const skills = [
    { id: "a", label: "A", description: "", actions: [] },
    { id: "b", label: "B", description: "", actions: [] },
  ];
  assert.deepEqual(scopeSkills(skills, undefined).map((skill) => skill.id), ["a", "b"]);
  assert.deepEqual(scopeSkills(skills, []).map((skill) => skill.id), []);
  assert.deepEqual(scopeSkills(skills, ["b"]).map((skill) => skill.id), ["b"]);
  assert.deepEqual(scopeSkills(skills, ["b", "已删除的 skill"]).map((skill) => skill.id), ["b"]);
});

test("registryForScope 复用全量实例，裁剪后只认启用的工具", () => {
  const { db } = seed();
  const runtime = createAgentRuntime(db);
  assert.equal(registryForScope(runtime.registry, undefined), runtime.registry, "未设置时不应新造注册表");
  const scoped = registryForScope(runtime.registry, ["deck"]);
  assert.ok(scoped.findAction("deck.generate"));
  assert.equal(scoped.findAction("file.create"), undefined);
  assert.ok(runtime.registry.findAction("file.create"), "全量注册表不受影响");
});

test("任务级启停持久化：数组表示启用清单，null 恢复全部", () => {
  const { db, threadId } = seed();
  assert.equal(db.getAgentThread(OWNER, threadId)?.enabledSkills, undefined);

  db.updateAgentThread(OWNER, threadId, { enabledSkills: ["deck", "deck"] });
  assert.deepEqual(db.getAgentThread(OWNER, threadId)?.enabledSkills, ["deck"], "重复 id 去重");

  db.updateAgentThread(OWNER, threadId, { enabledSkills: [] });
  assert.deepEqual(db.getAgentThread(OWNER, threadId)?.enabledSkills, [], "空数组不能被当成未设置");

  db.updateAgentThread(OWNER, threadId, { enabledSkills: null });
  assert.equal(db.getAgentThread(OWNER, threadId)?.enabledSkills, undefined);

  // 只改标题不能顺手清掉 Skill 设置
  db.updateAgentThread(OWNER, threadId, { enabledSkills: ["web"] });
  db.updateAgentThread(OWNER, threadId, { title: "改名" });
  assert.deepEqual(db.getAgentThread(OWNER, threadId)?.enabledSkills, ["web"]);
});

test("停用 Skill 后模型看不到对应工具，调用被当作未知工具", async () => {
  const { dir, db, threadId } = seed();
  const runtime = createAgentRuntime(db);
  const scoped = registryForScope(runtime.registry, ["deck"]);
  db.updateAgentThread(OWNER, threadId, { enabledSkills: ["deck"] });

  const model = new ScriptedModel([
    { toolCalls: [{ id: "call-1", name: "file.create", arguments: { path: "a.md", content: "A" } }] },
    { content: "该能力在本任务已停用。" },
  ]);
  const run = await runtime.runs.start({
    ownerUserId: OWNER,
    threadId,
    history: [{ role: "user", content: "写个文件" }],
    workingDirectory: dir,
    intent: "写个文件",
    registry: scoped,
    provider: async () => ({ model, systemPrompt: "系统说明" }),
  });
  assert.equal(run.status, "completed", "未知工具不应卡在审批点");
  assert.equal(fs.existsSync(path.join(dir, "a.md")), false);
  assert.equal(db.listAgentToolCalls(OWNER, run.id).length, 0, "未注册的工具不登记为动作");
  assert.equal(db.listAgentActionReceipts(OWNER, threadId).length, 0);

  const toolNames = model.inputs[0].tools.map((tool) => tool.name);
  assert.ok(toolNames.includes("deck.generate"));
  assert.ok(!toolNames.includes("file.create"), "模型可见的工具必须只剩启用的");
  assert.ok(!toolNames.includes("web.build"));
});

test("快照同时给出全量 Skill 与启用范围，面板才能重新启用", async () => {
  const { dir, db, threadId } = seed();
  const runtime = createAgentRuntime(db);
  db.updateAgentThread(OWNER, threadId, { enabledSkills: ["deck"] });
  const scoped = registryForScope(runtime.registry, ["deck"]);
  const snapshot = runtime.runs.snapshot({
    ownerUserId: OWNER,
    threadId,
    workingDirectory: dir,
    enabledSkills: ["deck"],
  });
  const ids = snapshot.skills.map((skill) => skill.id);
  assert.ok(ids.includes("deck"));
  assert.ok(ids.includes("local-file"), "全量清单必须包含被停用的，否则无法重新启用");
  assert.deepEqual(snapshot.enabledSkills, ["deck"]);
});
