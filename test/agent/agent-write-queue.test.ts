import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VbkDatabase } from "../../src/main/infrastructure/database/database.js";
import { createAgentRuntime, type AgentSkill } from "../../src/main/agent-runtime/index.js";

const OWNER = 1001;

function seed(): { db: VbkDatabase; threadId: string; otherThreadId: string; runId: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vbk-write-queue-"));
  const db = new VbkDatabase(path.join(dir, "data"));
  const thread = db.createAgentThread(OWNER, { title: "任务 A" });
  const other = db.createAgentThread(OWNER, { title: "任务 B" });
  const run = db.createAgentRun(OWNER, { threadId: thread.id, intent: "写" });
  return { db, threadId: thread.id, otherThreadId: other.id, runId: run.id };
}

/** 可控放行的写动作：用来观察"正在写 / 排队中"。 */
function gatedSkill(accountKey: string): { skill: AgentSkill; release: (tag: string) => void } {
  const gates = new Map<string, () => void>();
  const skill: AgentSkill = {
    id: `gated-${accountKey}`,
    label: "慢写",
    description: "测试用",
    actions: [{
      name: `gated.write.${accountKey}`,
      kind: "write",
      label: "慢写",
      risk: "medium",
      description: "测试用慢写",
      parameters: { type: "object", properties: {} },
      async target() {
        return { action: `gated.write.${accountKey}`, targetKey: "/virtual/target", accountKey, risk: "medium" };
      },
      async execute(args) {
        await new Promise<void>((resolve) => gates.set(String(args.tag), resolve));
        return { content: `done:${String(args.tag)}`, summary: "写入完成", result: "ok" };
      },
    }],
  };
  return { skill, release: (tag) => gates.get(tag)?.() };
}

function toolCall(db: VbkDatabase, owner: number, ids: { runId: string; threadId: string }, key: string, action: string, tag: string) {
  return db.insertAgentToolCall(owner, {
    runId: ids.runId,
    threadId: ids.threadId,
    skillId: "gated",
    toolName: action,
    arguments: { tag },
    status: "awaiting_approval",
    kind: "write",
    risk: "medium",
    idempotencyKey: key,
    summary: `写入 ${tag}`,
  });
}

const noopContext = (threadId: string, runId: string) => ({ ownerUserId: OWNER, threadId, runId });

function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - started > timeoutMs) return reject(new Error("等待队列状态超时"));
      setTimeout(tick, 5);
    };
    tick();
  });
}

test("同账号写操作串行时暴露「正在写 + 排队」状态", async () => {
  const { db, threadId, runId } = seed();
  const { skill, release } = gatedSkill("vbk_671205");
  const runtime = createAgentRuntime(db, { skills: [skill] });
  const action = skill.actions[0];
  const target = { action: action.name, targetKey: "/virtual/target", accountKey: "vbk_671205", risk: "medium" as const };
  const ids = { runId, threadId };

  const first = runtime.executor.execute({
    ownerUserId: OWNER, threadId, runId, action, args: { tag: "a" }, target,
    context: noopContext(threadId, runId), toolCall: toolCall(db, OWNER, ids, "q-1", action.name, "a"),
  });
  await waitFor(() => runtime.executor.queueStates().some((state) => state.running));

  const second = runtime.executor.execute({
    ownerUserId: OWNER, threadId, runId, action, args: { tag: "b" }, target,
    context: noopContext(threadId, runId), toolCall: toolCall(db, OWNER, ids, "q-2", action.name, "b"),
  });
  await waitFor(() => runtime.executor.queueStates().some((state) => state.waiting === 1));

  const queued = runtime.executor.queueStates();
  assert.equal(queued.length, 1);
  assert.equal(queued[0].accountKey, `vbk_671205`);
  assert.equal(queued[0].running, true);
  assert.equal(queued[0].waiting, 1);
  assert.ok(queued[0].since);
  assert.equal(queued[0].holderThreadId, threadId);

  release("a");
  await first;
  release("b");
  await second;
  assert.deepEqual(runtime.executor.queueStates(), [], "队列空后不再暴露状态");
});

test("不同账号并行时两个队列各自「正在写」，没有排队", async () => {
  const { db, threadId, runId } = seed();
  const a = gatedSkill("account-a");
  const b = gatedSkill("account-b");
  const runtime = createAgentRuntime(db, { skills: [a.skill, b.skill] });
  const ids = { runId, threadId };

  const first = runtime.executor.execute({
    ownerUserId: OWNER, threadId, runId, action: a.skill.actions[0], args: { tag: "a" },
    target: { action: a.skill.actions[0].name, targetKey: "/v/a", accountKey: "account-a", risk: "medium" },
    context: noopContext(threadId, runId), toolCall: toolCall(db, OWNER, ids, "p-1", a.skill.actions[0].name, "a"),
  });
  const second = runtime.executor.execute({
    ownerUserId: OWNER, threadId, runId, action: b.skill.actions[0], args: { tag: "b" },
    target: { action: b.skill.actions[0].name, targetKey: "/v/b", accountKey: "account-b", risk: "medium" },
    context: noopContext(threadId, runId), toolCall: toolCall(db, OWNER, ids, "p-2", b.skill.actions[0].name, "b"),
  });
  await waitFor(() => runtime.executor.queueStates().filter((state) => state.running).length === 2);
  const states = runtime.executor.queueStates();
  assert.deepEqual(states.map((state) => state.accountKey).sort(), ["account-a", "account-b"]);
  assert.ok(states.every((state) => state.running && state.waiting === 0));

  a.release("a");
  b.release("b");
  await Promise.all([first, second]);
});

test("跨任务竞争同一账号时，持锁方是另一个任务", async () => {
  const { db, threadId, otherThreadId, runId } = seed();
  const { skill, release } = gatedSkill("shared-account");
  const runtime = createAgentRuntime(db, { skills: [skill] });
  const action = skill.actions[0];
  const target = { action: action.name, targetKey: "/v/shared", accountKey: "shared-account", risk: "medium" as const };

  const first = runtime.executor.execute({
    ownerUserId: OWNER, threadId, runId, action, args: { tag: "a" }, target,
    context: noopContext(threadId, runId), toolCall: toolCall(db, OWNER, { runId, threadId }, "x-1", action.name, "a"),
  });
  await waitFor(() => runtime.executor.queueStates().some((state) => state.running));

  const second = runtime.executor.execute({
    ownerUserId: OWNER, threadId: otherThreadId, runId, action, args: { tag: "b" }, target,
    context: noopContext(otherThreadId, runId), toolCall: toolCall(db, OWNER, { runId, threadId: otherThreadId }, "x-2", action.name, "b"),
  });
  await waitFor(() => runtime.executor.queueStates().some((state) => state.waiting === 1));

  const [state] = runtime.executor.queueStates();
  assert.equal(state.holderThreadId, threadId, "持锁的是任务 A，不是发起方");
  assert.equal(state.waiting, 1, "任务 B 在排队");

  release("a");
  await first;
  await waitFor(() => runtime.executor.queueStates().some((entry) => entry.holderThreadId === otherThreadId));
  release("b");
  await second;
});

test("运行时快照带上非空写队列，空队列时不带该字段", async () => {
  const { db, threadId, runId } = seed();
  const { skill, release } = gatedSkill("snapshot-account");
  const runtime = createAgentRuntime(db, { skills: [skill] });
  const action = skill.actions[0];

  assert.equal(runtime.runs.snapshot({ ownerUserId: OWNER, threadId }).writeQueues, undefined);

  const pending = runtime.executor.execute({
    ownerUserId: OWNER, threadId, runId, action, args: { tag: "a" },
    target: { action: action.name, targetKey: "/v/s", accountKey: "snapshot-account", risk: "medium" },
    context: noopContext(threadId, runId), toolCall: toolCall(db, OWNER, { runId, threadId }, "s-1", action.name, "a"),
  });
  await waitFor(() => runtime.executor.queueStates().some((state) => state.running));
  const snapshot = runtime.runs.snapshot({ ownerUserId: OWNER, threadId });
  assert.equal(snapshot.writeQueues?.length, 1);
  assert.equal(snapshot.writeQueues?.[0].accountKey, "snapshot-account");
  assert.equal(snapshot.writeQueues?.[0].running, true);

  release("a");
  await pending;
});
