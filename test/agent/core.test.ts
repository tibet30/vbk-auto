import assert from "node:assert/strict";
import test from "node:test";
import { AgentCore } from "../../src/main/agent/core.js";
import type { AgentCoreDependencies } from "../../src/main/agent/types.js";
import type { AgentSnapshot } from "../../src/shared/contracts.js";

function harness(results: Array<{ content?: string; toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }> }>) {
  const saved = new Map<string, AgentSnapshot>();
  const deps: AgentCoreDependencies = {
    model: { complete: async () => results.shift() ?? { content: "done" } },
    tools: [{ name: "read", description: "read", parameters: {}, execute: async () => ({ content: "ok" }) }],
    accountFor: async () => ({ accountKey: "account", productVersion: "version" }),
    id: (() => { let n = 0; return () => `id-${++n}`; })(),
    now: () => new Date("2026-09-05T00:00:00.000Z"),
  };
  return { core: new AgentCore(deps, { getAgentSnapshot: (id) => saved.get(id), saveAgentSnapshot: (value) => { saved.set(value.localProductId, structuredClone(value)); } }), saved, deps };
}

test("AgentCore persists tool-call/result pairing and completes a read-only run", async () => {
  const { core } = harness([{ toolCalls: [{ id: "call-1", name: "read", arguments: {} }] }, { content: "finished" }]);
  await core.send("product-1", "开始"); await core.idle("product-1"); const result = await core.get("product-1");
  assert.equal(result.run?.status, "completed");
  assert.deepEqual(result.events.filter((event) => event.type === "tool_call" || event.type === "tool_result").map((event) => event.data?.toolCallId), ["call-1", "call-1"]);
});

test("AgentCore holds user input durably and resumes with a paired tool result", async () => {
  const { core } = harness([{ toolCalls: [{ id: "ask-1", name: "ask_user", arguments: { questions: [{ id: "city", label: "城市", kind: "text", required: true }] } }] }, { content: "finished" }]);
  await core.send("product-2", "规划"); await core.idle("product-2"); const waiting = await core.get("product-2");
  assert.equal(waiting.run?.status, "waiting_input");
  await core.respond("product-2", { requestId: waiting.pendingInput!.id, answers: { city: "成都" } }); await core.idle("product-2"); const done = await core.get("product-2");
  assert.equal(done.run?.status, "completed");
  assert.ok(done.events.some((event) => event.type === "tool_result" && event.data?.toolCallId === "ask-1"));
});

test("AgentCore auto-adopts default traffic and vehicle-seat questions", async () => {
  const { core } = harness([
    { toolCalls: [{ id: "ask-1", name: "ask_user", arguments: { questions: [
      { id: "traffic", label: "出发城市交通方式", kind: "multiple", required: true, options: [
        { id: "flight", label: "飞机往返" },
        { id: "train", label: "火车往返" },
      ] },
      { id: "seats", label: "用车座位数", kind: "single", required: true, options: [
        { id: "5", label: "5座" },
        { id: "7", label: "7座" },
      ] },
    ] } }] },
    { content: "finished" },
  ]);
  await core.send("defaults-only", "规划");
  await core.idle("defaults-only");
  const done = await core.get("defaults-only");
  assert.equal(done.run?.status, "completed");
  assert.equal(done.pendingInput, undefined);
  const result = done.events.find((event) => event.type === "tool_result" && event.data?.toolCallId === "ask-1");
  assert.equal(result?.content, JSON.stringify({ traffic: ["flight", "train"], seats: "5" }));
});

test("AgentCore hides default questions while preserving their answers", async () => {
  const { core } = harness([
    { toolCalls: [{ id: "ask-1", name: "ask_user", arguments: { questions: [
      { id: "traffic", label: "出发城市交通方式", kind: "multiple", required: true, options: [
        { id: "flight", label: "飞机往返" },
        { id: "train", label: "火车往返" },
      ] },
      { id: "pace", label: "希望每天怎样安排？", kind: "text", required: true },
    ] } }] },
    { content: "finished" },
  ]);
  await core.send("mixed-defaults", "规划");
  await core.idle("mixed-defaults");
  const waiting = await core.get("mixed-defaults");
  assert.deepEqual(waiting.pendingInput?.questions.map((question) => question.id), ["pace"]);
  await core.respond("mixed-defaults", { requestId: waiting.pendingInput!.id, answers: { pace: "轻松一点" } });
  await core.idle("mixed-defaults");
  const done = await core.get("mixed-defaults");
  const result = done.events.find((event) => event.type === "tool_result" && event.data?.toolCallId === "ask-1");
  assert.equal(result?.content, JSON.stringify({ traffic: ["flight", "train"], pace: "轻松一点" }));
});

test("AgentCore auto-adopts first five hotel candidates without asking", async () => {
  const { core } = harness([
    { toolCalls: [{ id: "ask-1", name: "ask_user", arguments: { questions: [
      { id: "hotels", label: "请选择酒店候选", kind: "single", required: true, options: [
        { id: "a", label: "酒店A" },
        { id: "b", label: "酒店B" },
        { id: "c", label: "酒店C" },
        { id: "d", label: "酒店D" },
        { id: "e", label: "酒店E" },
        { id: "f", label: "酒店F" },
      ] },
    ] } }] },
    { content: "finished" },
  ]);
  await core.send("hotel-defaults", "规划");
  await core.idle("hotel-defaults");
  const done = await core.get("hotel-defaults");
  assert.equal(done.run?.status, "completed");
  assert.equal(done.pendingInput, undefined);
  const result = done.events.find((event) => event.type === "tool_result" && event.data?.toolCallId === "ask-1");
  assert.equal(result?.content, JSON.stringify({ hotels: ["a", "b", "c", "d", "e"] }));
});

test("AgentCore requires scope, product version, and account binding for writes", async () => {
  const { core, deps } = harness([{ toolCalls: [{ id: "write-1", name: "write", arguments: { phase: "basic" } }] }, { content: "done" }]);
  let writes = 0;
  deps.tools = [{ name: "write", description: "write", parameters: {}, write: true, approvalScope: (args) => [`phase:${String(args.phase)}`], execute: async () => { writes += 1; return { content: "written" }; } }];
  await core.send("product-3", "写入"); await core.idle("product-3"); const unapproved = await core.get("product-3");
  assert.equal(writes, 0);
  assert.ok(unapproved.events.some((event) => /需要当前意图/.test(event.content)));
});

test("send returns before a deferred model finishes", async () => {
  let release!: () => void;
  const { core } = harness([{ content: "done" }]);
  const original = (core as unknown as { deps: AgentCoreDependencies }).deps.model!;
  (core as unknown as { deps: AgentCoreDependencies }).deps.model = { complete: async (input) => { await new Promise<void>((resolve) => { release = resolve; }); return original.complete(input); } };
  const snapshot = await core.send("fast", "go"); assert.equal(snapshot.run?.status, "running"); await new Promise((resolve) => setImmediate(resolve)); release(); await core.idle("fast");
});

test("streamed model text updates one durable assistant event before completion", async () => {
  const saved: AgentSnapshot[] = [];
  const deps: AgentCoreDependencies = {
    model: { complete: async (input) => {
      await input.onContent?.("正在");
      await input.onContent?.("正在生成");
      return { content: "正在生成完成" };
    } },
    tools: [],
    accountFor: async () => ({ accountKey: "account", productVersion: "version" }),
  };
  const core = new AgentCore(deps, {
    getAgentSnapshot: () => saved.at(-1),
    saveAgentSnapshot: (snapshot) => { saved.push(structuredClone(snapshot)); },
  });
  await core.send("stream", "开始");
  await core.idle("stream");
  assert.ok(saved.some((snapshot) => snapshot.events.some((event) => event.data?.streaming === true)));
  const assistants = (await core.get("stream")).events.filter((event) => event.type === "assistant");
  assert.equal(assistants.length, 1);
  assert.equal(assistants[0]?.content, "正在生成完成");
  assert.equal(assistants[0]?.data?.streaming, false);
});

test("a new user send starts a new run after completion", async () => {
  const { core } = harness([{ content: "one" }, { content: "two" }]); await core.send("new", "one"); await core.idle("new"); const first = (await core.get("new")).run!.id; await core.send("new", "two"); const second = (await core.get("new")).run!.id; assert.notEqual(first, second);
});

test("abandoned work is not resumed but a new send starts a run", async () => {
  const { core } = harness([{ content: "done" }]); await core.send("abandon", "go"); await core.abandon("abandon"); assert.equal((await core.resume("abandon")).run?.status, "abandoned"); assert.equal((await core.send("abandon", "new")).run?.status, "running");
});

test("invalid native questions are returned as a tool result", async () => {
  const { core } = harness([{ toolCalls: [{ id: "bad", name: "ask_user", arguments: { questions: [] } }] }, { content: "done" }]); await core.send("badq", "go"); await core.idle("badq"); assert.ok((await core.get("badq")).events.some((e) => /问题格式无效/.test(e.content)));
});

test("required answers reject missing values", async () => {
  const { core } = harness([{ toolCalls: [{ id: "ask", name: "ask_user", arguments: { questions: [{ id: "x", label: "X", kind: "text", required: true }] } }] }]); await core.send("answers", "go"); await core.idle("answers"); const s = await core.get("answers"); const result = await core.respond("answers", { requestId: s.pendingInput!.id, answers: {} }); assert.equal(result.run?.status, "waiting_input");
});

test("schema rejects a missing required tool argument", async () => {
  const { core, deps } = harness([{ toolCalls: [{ id: "read", name: "read", arguments: {} }] }, { content: "done" }]); deps.tools = [{ name: "read", description: "read", parameters: { required: ["city"] }, execute: async () => ({ content: "never" }) }]; await core.send("schema", "go"); await core.idle("schema"); assert.ok((await core.get("schema")).events.some((e) => /缺少 city/.test(e.content)));
});

test("local writes can opt out of external approval", async () => {
  const { core, deps } = harness([{ toolCalls: [{ id: "local", name: "local", arguments: {} }] }, { content: "done" }]); let called = false; deps.tools = [{ name: "local", description: "local", parameters: {}, write: true, requiresApproval: false, execute: async () => { called = true; return { content: "saved" }; } }]; await core.send("local", "go"); await core.idle("local"); assert.equal(called, true);
});

test("approval precondition prevents an approval card", async () => {
  const { core, deps } = harness([{ toolCalls: [{ id: "approval", name: "request_approval", arguments: { scope: ["x"], summary: "x" } }] }, { content: "done" }]); deps.approvalPrecondition = async () => "未准备好"; await core.send("pre", "go"); await core.idle("pre"); assert.equal((await core.get("pre")).pendingApproval, undefined);
});

test("multi-tool calls are persisted before their results", async () => {
  const { core, deps } = harness([{ toolCalls: [{ id: "a", name: "read", arguments: {} }, { id: "b", name: "read", arguments: {} }] }, { content: "done" }]); const orders: string[] = []; deps.tools[0]!.execute = async () => { orders.push("execute"); return { content: "ok" }; }; await core.send("multi", "go"); await core.idle("multi"); const events = (await core.get("multi")).events; assert.ok(events.findIndex((e) => e.data?.toolCallId === "b") < events.findIndex((e) => e.type === "tool_result")); assert.equal(orders.length, 2);
});

test("stored running state is paused on a fresh core get", async () => {
  const { core, saved } = harness([]); saved.set("restart", { localProductId: "restart", run: { id: "r", status: "running", createdAt: "x", updatedAt: "x" }, events: [] }); assert.equal((await core.get("restart")).run?.status, "paused");
});

test("uncertain writes block resume until reconciliation", async () => {
  const { core, deps } = harness([{ toolCalls: [{ id: "write", name: "write", arguments: {} }] }]); deps.tools = [{ name: "write", description: "write", parameters: {}, write: true, requiresApproval: false, execute: async () => ({ content: "maybe", uncertainWrite: true }) }]; await core.send("uncertain", "go"); await core.idle("uncertain"); assert.equal((await core.get("uncertain")).run?.status, "paused"); assert.equal((await core.resume("uncertain")).run?.status, "paused");
});

test("illegal keyword repair records blacklist progress and restarts generation", async () => {
  const { core, saved } = harness([{ content: "已重写图文" }]);
  saved.set("illegal-copy", {
    localProductId: "illegal-copy",
    run: { id: "run", status: "paused", createdAt: "x", updatedAt: "x", intentVersion: "old" },
    uncertainWrite: {
      toolCallId: "write-presentation",
      message: "产品图文接口保存失败：Ack=Warning：非法关键词：朝圣 \n非法关键词：贵族",
      createdAt: "x",
    },
    events: [],
  });

  const started = await core.repairIllegalKeywords("illegal-copy", {
    content: "请把朝圣、贵族作为黑名单并重写图文",
    keywords: ["朝圣", "贵族"],
    affectedPaths: ["presentation.recommendation", "presentation.features"],
  });
  assert.equal(started.run?.status, "running");
  assert.equal(started.uncertainWrite, undefined);
  assert.ok(started.events.some((event) => event.type === "status" && /已记录 VBK 文案黑名单：朝圣、贵族/.test(event.content)));

  await core.idle("illegal-copy");
  const done = await core.get("illegal-copy");
  assert.equal(done.run?.status, "completed");
  assert.ok(done.events.some((event) => event.type === "assistant" && event.content === "已重写图文"));
});

test("stale approval response is ignored", async () => {
  const { core } = harness([{ toolCalls: [{ id: "approval", name: "request_approval", arguments: { scope: ["x"], summary: "x" } }] }]); await core.send("stale", "go"); await core.idle("stale"); const s = await core.get("stale"); const result = await core.approve("stale", { approvalId: "wrong", productVersion: s.pendingApproval!.productVersion }); assert.equal(result.pendingApproval?.id, s.pendingApproval?.id);
});
