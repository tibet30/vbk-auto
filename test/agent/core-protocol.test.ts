import assert from "node:assert/strict";
import test from "node:test";
import { AgentCore } from "../../src/main/agent/core.js";
import { buildModelMessages } from "../../src/main/agent/core-transcript.js";
import type { AgentCoreDependencies, AgentModelMessage, AgentModelResult } from "../../src/main/agent/types.js";
import type { AgentEvent, AgentSnapshot } from "../../src/shared/contracts.js";

function protocolHarness(results: AgentModelResult[]) {
  const saved = new Map<string, AgentSnapshot>();
  const inputs: AgentModelMessage[][] = [];
  const deps: AgentCoreDependencies = {
    model: { complete: async (input) => { inputs.push(structuredClone(input.messages)); return results.shift() ?? { content: "done" }; } },
    tools: [{ name: "read", description: "read", parameters: { type: "object" }, execute: async () => ({ content: "ok" }) }],
    accountFor: async () => ({ accountKey: "account", productVersion: "version" }),
    productFingerprint: async () => "same-product",
    id: (() => { let index = 0; return () => `id-${++index}`; })(),
    now: () => new Date("2026-09-05T00:00:00.000Z"),
  };
  const store = {
    getAgentSnapshot: (id: string) => saved.get(id),
    saveAgentSnapshot: (snapshot: AgentSnapshot) => { saved.set(snapshot.localProductId, structuredClone(snapshot)); },
  };
  return { core: new AgentCore(deps, store), deps, inputs, saved };
}

test("native transcript keeps one assistant multi-call message adjacent to all results", async () => {
  const { core, inputs } = protocolHarness([
    { content: "checking", toolCalls: [
      { id: "call-a", name: "read", arguments: {} },
      { id: "call-b", name: "read", arguments: {} },
    ] },
    { content: "done" },
  ]);
  await core.send("protocol", "start");
  await core.idle("protocol");
  const history = inputs[1]!.slice(1);
  assert.deepEqual(history.map((message) => message.role), ["user", "assistant", "tool", "tool"]);
  assert.equal(history[1]?.content, "checking");
  assert.deepEqual(history[1]?.toolCalls?.map((call) => call.id), ["call-a", "call-b"]);
  assert.deepEqual(history.slice(2).map((message) => message.toolCallId), ["call-a", "call-b"]);
});

test("waiting in a multi-call group cancels omitted calls and keeps protocol valid after response", async () => {
  const { core, inputs } = protocolHarness([
    { toolCalls: [
      { id: "ask", name: "ask_user", arguments: { questions: [{ id: "city", label: "城市", kind: "text" }] } },
      { id: "omitted", name: "read", arguments: {} },
    ] },
    { content: "done" },
  ]);
  await core.send("native", "start");
  await core.idle("native");
  const waiting = await core.get("native");
  const omitted = waiting.events.find((event) => event.type === "tool_result" && event.data?.toolCallId === "omitted");
  assert.equal(omitted?.data?.cancelled, true);
  await core.respond("native", { requestId: waiting.pendingInput!.id, answers: { city: "成都" } });
  await core.idle("native");
  const history = inputs[1]!.slice(1);
  assert.deepEqual(history.map((message) => message.role), ["user", "assistant", "tool", "tool", "user"]);
  assert.deepEqual(history.slice(2, 4).map((message) => message.toolCallId), ["ask", "omitted"]);
});

test("history truncation retains complete tool groups and drops orphan results", () => {
  const events: AgentEvent[] = Array.from({ length: 130 }, (_, index) => ({
    id: `user-${index}`, runId: "run", type: "user", createdAt: "x", content: `u${index}`,
  }));
  events.push(
    { id: "tc-a", runId: "run", type: "tool_call", createdAt: "x", content: "read", data: { modelTurnId: "turn", toolCallId: "a", arguments: {} } },
    { id: "tc-b", runId: "run", type: "tool_call", createdAt: "x", content: "read", data: { modelTurnId: "turn", toolCallId: "b", arguments: {} } },
    { id: "tr-a", runId: "run", type: "tool_result", createdAt: "x", content: "a", data: { toolCallId: "a" } },
    { id: "tr-b", runId: "run", type: "tool_result", createdAt: "x", content: "b", data: { toolCallId: "b" } },
    { id: "orphan", runId: "run", type: "tool_result", createdAt: "x", content: "bad", data: { toolCallId: "missing" } },
  );
  const messages = buildModelMessages("system", events, 6);
  assert.deepEqual(messages.slice(-3).map((message) => message.role), ["assistant", "tool", "tool"]);
  assert.deepEqual(messages.slice(-2).map((message) => message.toolCallId), ["a", "b"]);
  assert.ok(messages.every((message) => message.content !== "bad"));
});

test("history character budget keeps the newest user and only complete tool groups", () => {
  const events: AgentEvent[] = [
    { id: "old-user", runId: "run", type: "user", createdAt: "x", content: "old" },
    { id: "old-call", runId: "run", type: "tool_call", createdAt: "x", content: "read",
      data: { modelTurnId: "old-turn", toolCallId: "old", arguments: {} } },
    { id: "old-result", runId: "run", type: "tool_result", createdAt: "x", content: "x".repeat(500), data: { toolCallId: "old" } },
    { id: "latest-user", runId: "run", type: "user", createdAt: "x", content: "latest" },
    { id: "new-call", runId: "run", type: "tool_call", createdAt: "x", content: "read",
      data: { modelTurnId: "new-turn", toolCallId: "new", arguments: {} } },
    { id: "new-result", runId: "run", type: "tool_result", createdAt: "x", content: "small", data: { toolCallId: "new" } },
  ];
  const messages = buildModelMessages("system", events, 120, 220);
  assert.ok(messages.some((message) => message.role === "user" && message.content === "latest"));
  assert.ok(messages.some((message) => message.role === "tool" && message.toolCallId === "new"));
  assert.ok(messages.every((message) => message.toolCallId !== "old"));
  assert.ok(messages.every((message) => message.toolCalls?.every((call) => call.id !== "old") ?? true));
});

test("stored assistant reasoning is stripped from model history", () => {
  const messages = buildModelMessages("system", [{
    id: "assistant", runId: "run", type: "assistant", createdAt: "x",
    content: "<think>private chain</think>Visible answer",
  }]);
  assert.equal(messages[1]?.content, "Visible answer");
});

test("incomplete streamed assistant text is excluded from model history", () => {
  const events: AgentEvent[] = [
    { id: "user", runId: "run", type: "user", createdAt: "x", content: "继续" },
    { id: "stream", runId: "run", type: "assistant", createdAt: "x", content: "半截回复", data: { streaming: true } },
    { id: "interrupted", runId: "run", type: "assistant", createdAt: "x", content: "已中止回复", data: { interrupted: true } },
  ];
  assert.deepEqual(buildModelMessages("system", events).map((message) => message.content), ["system", "继续"]);
});

test("malformed tool JSON is fed back without executing or guessing empty arguments", async () => {
  const { core, deps, inputs } = protocolHarness([
    { toolCalls: [{ id: "bad-json", name: "write", arguments: {}, rawArguments: "{oops", argumentError: "Unexpected token" }] },
    { content: "done" },
  ]);
  let executions = 0;
  deps.tools = [{ name: "write", description: "write", parameters: { type: "object" }, write: true, requiresApproval: false,
    execute: async () => { executions += 1; return { content: "written" }; } }];
  await core.send("malformed", "start");
  await core.idle("malformed");
  assert.equal(executions, 0);
  const assistant = inputs[1]!.find((message) => message.role === "assistant" && message.toolCalls?.length);
  assert.equal(assistant?.toolCalls?.[0]?.rawArguments, "{oops");
  assert.ok(inputs[1]!.some((message) => message.role === "tool" && /JSON 无效/.test(message.content)));
});

test("pure queries complete without invoking a write completion gate", async () => {
  const { core, deps } = protocolHarness([{ content: "answer" }]);
  let gates = 0;
  deps.finishVerified = async () => { gates += 1; return { verified: false }; };
  await core.send("query", "question");
  await core.idle("query");
  assert.equal((await core.get("query")).run?.status, "completed");
  assert.equal(gates, 0);
});

test("write completion gate can create a durable final approval without a synthetic tool result", async () => {
  const { core, deps } = protocolHarness([
    { toolCalls: [{ id: "local-write", name: "local", arguments: {} }] },
    { content: "ready" },
  ]);
  deps.tools = [{ name: "local", description: "local", parameters: { type: "object" }, write: true, requiresApproval: false,
    execute: async () => ({ content: "saved" }) }];
  deps.finishVerified = async (_id, context) => ({
    verified: false,
    message: `writes=${context?.hadWrites}`,
    finalApproval: { scope: ["vbk.write_phase:basic"], summary: "确认写入 VBK 基础信息" },
  });
  await core.send("finish", "create");
  await core.idle("finish");
  const snapshot = await core.get("finish");
  assert.equal(snapshot.run?.status, "waiting_approval");
  assert.deepEqual(snapshot.pendingApproval?.scope, ["vbk.write_phase:basic"]);
  assert.ok(snapshot.events.filter((event) => event.type === "tool_result")
    .every((event) => typeof event.data?.toolCallId === "string"));
});

test("invalidated final approval is fed back to the model as completion guidance", async () => {
  const { core, deps, inputs } = protocolHarness([
    { toolCalls: [{ id: "local-write", name: "local", arguments: {} }] },
    { content: "ready" },
    { content: "adjusted" },
  ]);
  deps.tools = [{ name: "local", description: "local", parameters: { type: "object" }, write: true, requiresApproval: false,
    execute: async () => ({ content: "saved" }) }];
  let changed = false;
  deps.approvalPrecondition = async () => changed ? "产品状态已变化" : undefined;
  deps.finishVerified = async () => ({
    verified: false,
    finalApproval: { scope: ["vbk.write_phase:basic"], summary: "确认写入 VBK 基础信息" },
  });
  await core.send("finish-invalid", "create");
  await core.idle("finish-invalid");
  const waiting = await core.get("finish-invalid");
  changed = true;
  await core.approve("finish-invalid", {
    approvalId: waiting.pendingApproval!.id,
    productVersion: waiting.pendingApproval!.productVersion,
  });
  await core.idle("finish-invalid");
  assert.ok(inputs[2]!.some((message) => message.role === "system"
    && /完成检查反馈：授权前置条件已变化：产品状态已变化/.test(message.content)));
});

test("approval scopes are normalized before precondition checks and storage", async () => {
  const { core, deps } = protocolHarness([{
    toolCalls: [{ id: "approval", name: "request_approval", arguments: { scope: ["basic"], summary: "写入基础信息" } }],
  }]);
  let checked: string[] | undefined;
  deps.normalizeApprovalScope = async (_id, scope) => scope.map((item) => `vbk.write_phase:${item}`);
  deps.approvalPrecondition = async (_id, scope) => { checked = scope; return undefined; };
  await core.send("normalized-scope", "start");
  await core.idle("normalized-scope");
  const snapshot = await core.get("normalized-scope");
  assert.deepEqual(checked, ["vbk.write_phase:basic"]);
  assert.deepEqual(snapshot.pendingApproval?.scope, ["vbk.write_phase:basic"]);
});

test("an approved full scope is reused when the model asks for a remaining subset", async () => {
  const { core, deps } = protocolHarness([
    { toolCalls: [{ id: "full", name: "request_approval", arguments: { scope: ["basic", "pricingInventory"], summary: "完整录入授权" } }] },
    { toolCalls: [{ id: "remaining", name: "request_approval", arguments: { scope: ["pricingInventory"], summary: "价格库存授权" } }] },
    { content: "继续执行已授权阶段" },
  ]);
  let preconditionChecks = 0;
  deps.approvalPrecondition = async () => { preconditionChecks += 1; return undefined; };
  await core.send("reuse-approval", "开始");
  await core.idle("reuse-approval");
  const waiting = await core.get("reuse-approval");
  await core.approve("reuse-approval", {
    approvalId: waiting.pendingApproval!.id,
    productVersion: waiting.pendingApproval!.productVersion,
  });
  await core.idle("reuse-approval");
  const snapshot = await core.get("reuse-approval");
  assert.equal(snapshot.events.filter((event) => event.type === "approval_request").length, 1);
  assert.equal(snapshot.events.find((event) => event.type === "tool_result" && event.data?.toolCallId === "remaining")?.data?.reusedApproval, true);
  // Creation, renderer refresh, and user approval each validate once; the
  // repeated subset must not create another approval-precondition check.
  assert.equal(preconditionChecks, 3);
});

test("three approval blockers pause across reads and resume opens one finite retry window", async () => {
  const results: AgentModelResult[] = [
    ...["basic", "itinerary", "traffic"].map((scope, index) => ({ toolCalls: [
      { id: `read-${index}`, name: "read", arguments: {} },
      { id: `approval-${index}`, name: "request_approval", arguments: { scope: [scope], summary: scope } },
    ] })),
    ...["hotel", "quote", "publish"].map((scope, index) => ({ toolCalls: [
      { id: `retry-${index}`, name: "request_approval", arguments: { scope: [scope], summary: scope } },
    ] })),
    { content: "must not run" },
  ];
  const { core, deps, inputs } = protocolHarness(results);
  let accountLookups = 0;
  deps.accountFor = async () => { accountLookups += 1; return { accountKey: "account", productVersion: "version" }; };
  deps.approvalPrecondition = async () => "当前产品还未准备好";
  await core.send("approval-loop", "start");
  await core.idle("approval-loop");
  let snapshot = await core.get("approval-loop");
  assert.equal(snapshot.run?.status, "paused");
  assert.equal(inputs.length, 3);
  assert.equal(accountLookups, 0);
  assert.equal(snapshot.events.filter((event) => event.data?.noProgressBlocker === "approval_precondition").length, 3);
  for (const call of snapshot.events.filter((event) => event.type === "tool_call")) {
    assert.ok(snapshot.events.some((event) => event.type === "tool_result" && event.data?.toolCallId === call.data?.toolCallId));
  }

  await core.resume("approval-loop");
  await core.idle("approval-loop");
  snapshot = await core.get("approval-loop");
  assert.equal(snapshot.run?.status, "paused");
  assert.equal(inputs.length, 6);
  assert.equal(snapshot.events.filter((event) => event.data?.noProgressRetryWindow === true).length, 1);
});

test("three unauthorized writes pause even when read calls and write scopes differ", async () => {
  const results: AgentModelResult[] = ["basic", "itinerary", "traffic"].map((phase, index) => ({ toolCalls: [
    { id: `read-${index}`, name: "read", arguments: {} },
    { id: `write-${index}`, name: "write", arguments: { phase } },
  ] }));
  const { core, deps, inputs } = protocolHarness(results);
  let writes = 0;
  deps.tools.push({
    name: "write", description: "write", parameters: { type: "object" }, write: true,
    approvalScope: (args) => [`vbk.write_phase:${String(args.phase)}`],
    execute: async () => { writes += 1; return { content: "written" }; },
  });
  await core.send("authorization-loop", "start");
  await core.idle("authorization-loop");
  const snapshot = await core.get("authorization-loop");
  assert.equal(snapshot.run?.status, "paused");
  assert.equal(inputs.length, 3);
  assert.equal(writes, 0);
  assert.equal(snapshot.events.filter((event) => event.data?.noProgressBlocker === "authorization_denied").length, 3);
});

test("completion gate feedback reaches the model and pauses after three blocked completions", async () => {
  const { core, deps, inputs } = protocolHarness([
    { toolCalls: [{ id: "local-write", name: "local", arguments: {} }] },
    { content: "ready one" },
    { content: "ready two" },
    { content: "ready three" },
    { content: "must not run" },
  ]);
  deps.tools = [{ name: "local", description: "local", parameters: { type: "object" }, write: true, requiresApproval: false,
    execute: async () => ({ content: "saved", data: { changedSections: ["commercial"] } }) }];
  deps.finishVerified = async () => ({ verified: false, message: "缺少 commercial.packageName" });
  await core.send("completion-loop", "create product");
  await core.idle("completion-loop");
  const snapshot = await core.get("completion-loop");
  assert.equal(snapshot.run?.status, "paused");
  assert.equal(inputs.length, 4);
  assert.equal(snapshot.events.filter((event) => event.data?.completionBlocked === true).length, 3);
  assert.ok(inputs[2]!.some((message) => message.role === "system"
    && message.content === "完成检查反馈：缺少 commercial.packageName"));
});

test("only a local write with material changes resets the blocker count", async () => {
  for (const [changedSections, expected] of [[[], "paused"], [["basicInfo"], "completed"]] as const) {
    const results: AgentModelResult[] = [
      { toolCalls: [{ id: "approval-1", name: "request_approval", arguments: { scope: ["one"], summary: "one" } }] },
      { toolCalls: [{ id: "approval-2", name: "request_approval", arguments: { scope: ["two"], summary: "two" } }] },
      { toolCalls: [{ id: "local", name: "local", arguments: {} }] },
      { toolCalls: [{ id: "approval-3", name: "request_approval", arguments: { scope: ["three"], summary: "three" } }] },
      { toolCalls: [{ id: "approval-4", name: "request_approval", arguments: { scope: ["four"], summary: "four" } }] },
      { content: "done" },
    ];
    const { core, deps } = protocolHarness(results);
    deps.approvalPrecondition = async () => "not ready";
    deps.tools = [{ name: "local", description: "local", parameters: { type: "object" }, write: true, requiresApproval: false,
      execute: async () => ({ content: "saved", data: { changedSections: [...changedSections] } }) }];
    await core.send(`material-${changedSections.length}`, "start");
    await core.idle(`material-${changedSections.length}`);
    assert.equal((await core.get(`material-${changedSections.length}`)).run?.status, expected);
  }
});

test("native question schema tells the model the exact item and option shapes", async () => {
  const { core, deps } = protocolHarness([{ toolCalls: [{ id: "ask", name: "ask_user", arguments: { questions: [{ id: "x", label: "X", kind: "text" }] } }] }]);
  let schema: Record<string, unknown> | undefined;
  deps.model = { complete: async (input) => {
    schema = input.tools.find((tool) => tool.name === "ask_user")?.parameters;
    return { toolCalls: [{ id: "ask", name: "ask_user", arguments: { questions: [{ id: "x", label: "X", kind: "text" }] } }] };
  } };
  await core.send("schema-shape", "start");
  await core.idle("schema-shape");
  const questions = (schema?.properties as Record<string, Record<string, unknown>>).questions;
  assert.equal(questions.type, "array");
  assert.equal((questions.items as Record<string, unknown>).type, "object");
  assert.deepEqual((questions.items as Record<string, unknown>).required, ["id", "label", "kind"]);
});

test("answers reject whitespace required values and unknown keys", async () => {
  for (const answers of [{ x: "   " }, { x: "ok", hidden: "value" }]) {
    const { core } = protocolHarness([{ toolCalls: [{ id: "ask", name: "ask_user", arguments: { questions: [{ id: "x", label: "X", kind: "text" }] } }] }]);
    await core.send("answers", "start");
    await core.idle("answers");
    const waiting = await core.get("answers");
    const result = await core.respond("answers", { requestId: waiting.pendingInput!.id, answers });
    assert.equal(result.run?.status, "waiting_input");
  }
});
