import assert from "node:assert/strict";
import test from "node:test";
import { AgentCore } from "../../src/main/agent/core.js";
import type { AgentCoreDependencies, AgentModelMessage, AgentModelResult } from "../../src/main/agent/types.js";
import type { AgentSnapshot } from "../../src/shared/contracts.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function concurrencyHarness(complete: AgentCoreDependencies["model"]) {
  const saved = new Map<string, AgentSnapshot>();
  const deps: AgentCoreDependencies = {
    model: complete,
    tools: [],
    accountFor: async () => ({ accountKey: "account", productVersion: "version" }),
    productFingerprint: async () => "same-fingerprint",
    id: (() => { let index = 0; return () => `id-${++index}`; })(),
    now: () => new Date("2026-09-05T00:00:00.000Z"),
  };
  const core = new AgentCore(deps, {
    getAgentSnapshot: (id) => saved.get(id),
    saveAgentSnapshot: (snapshot) => { saved.set(snapshot.localProductId, structuredClone(snapshot)); },
  });
  return { core, deps, saved };
}

test("model output issued before new user steering is discarded", async () => {
  const firstStarted = deferred<void>();
  const firstResult = deferred<AgentModelResult>();
  let calls = 0;
  const { core, deps } = concurrencyHarness({ complete: async () => {
    calls += 1;
    if (calls === 1) { firstStarted.resolve(); return firstResult.promise; }
    return { content: "new answer" };
  } });
  let writes = 0;
  deps.tools = [{ name: "local", description: "local", parameters: { type: "object" }, write: true, requiresApproval: false,
    execute: async () => { writes += 1; return { content: "saved" }; } }];
  await core.send("steer", "first");
  await firstStarted.promise;
  await core.send("steer", "second");
  firstResult.resolve({ content: "stale answer", toolCalls: [{ id: "stale-write", name: "local", arguments: {} }] });
  await core.idle("steer");
  const snapshot = await core.get("steer");
  assert.equal(writes, 0);
  assert.ok(snapshot.events.some((event) => event.type === "assistant" && event.content === "new answer"));
  assert.ok(snapshot.events.every((event) => event.content !== "stale answer"));
});

test("pause during an async tool keeps the pause and persists its paired result", async () => {
  const toolStarted = deferred<void>();
  const toolResult = deferred<void>();
  let modelCalls = 0;
  const { core, deps } = concurrencyHarness({ complete: async () => {
    modelCalls += 1;
    return modelCalls === 1
      ? { toolCalls: [{ id: "slow", name: "slow", arguments: {} }] }
      : { content: "should not run" };
  } });
  deps.tools = [{ name: "slow", description: "slow", parameters: { type: "object" }, execute: async () => {
    toolStarted.resolve();
    await toolResult.promise;
    return { content: "slow result" };
  } }];
  await core.send("pause", "start");
  await toolStarted.promise;
  await core.pause("pause");
  toolResult.resolve();
  await core.idle("pause");
  const snapshot = await core.get("pause");
  assert.equal(snapshot.run?.status, "paused");
  assert.equal(modelCalls, 1);
  assert.ok(snapshot.events.some((event) => event.type === "tool_result" && event.data?.toolCallId === "slow"));
});

test("pause during an async local identity lookup prevents the pending tool from starting", async () => {
  const lookupStarted = deferred<void>();
  const lookupResult = deferred<string>();
  const { core, deps } = concurrencyHarness({ complete: async () => ({
    toolCalls: [{ id: "after-account", name: "read", arguments: {} }],
  }) });
  let executions = 0;
  let fingerprintCalls = 0;
  deps.productFingerprint = async () => {
    fingerprintCalls += 1;
    if (fingerprintCalls === 1) return "same-fingerprint";
    lookupStarted.resolve();
    return lookupResult.promise;
  };
  deps.tools = [{ name: "read", description: "read", parameters: { type: "object" }, execute: async () => {
    executions += 1;
    return { content: "bad" };
  } }];
  await core.send("account-race", "start");
  await lookupStarted.promise;
  await core.pause("account-race");
  lookupResult.resolve("same-fingerprint");
  await core.idle("account-race");
  const snapshot = await core.get("account-race");
  assert.equal(snapshot.run?.status, "paused");
  assert.equal(executions, 0);
  assert.equal(snapshot.events.find((event) => event.type === "tool_result" && event.data?.toolCallId === "after-account")?.data?.cancelled, true);
});

test("local and read-only tools do not require VBK account identity", async () => {
  const results: AgentModelResult[] = [
    { toolCalls: [{ id: "read", name: "read", arguments: {} }] },
    { content: "done" },
  ];
  const { core, deps } = concurrencyHarness({ complete: async () => results.shift() ?? { content: "done" } });
  let accountLookups = 0;
  deps.accountFor = async () => { accountLookups += 1; throw new Error("VBK not logged in"); };
  deps.tools = [{ name: "read", description: "read", parameters: { type: "object" },
    execute: async () => ({ content: "local result" }) }];
  await core.send("local-without-vbk", "start");
  await core.idle("local-without-vbk");
  assert.equal((await core.get("local-without-vbk")).run?.status, "completed");
  assert.equal(accountLookups, 0);
});

test("new send during a tool keeps new input and cancels the rest of the old call group", async () => {
  const toolStarted = deferred<void>();
  const toolResult = deferred<void>();
  let modelCalls = 0;
  const { core, deps } = concurrencyHarness({ complete: async () => {
    modelCalls += 1;
    return modelCalls === 1
      ? { toolCalls: [{ id: "slow", name: "slow", arguments: {} }, { id: "never", name: "never", arguments: {} }] }
      : { content: "new result" };
  } });
  let secondExecutions = 0;
  deps.tools = [
    { name: "slow", description: "slow", parameters: { type: "object" }, execute: async () => {
      toolStarted.resolve(); await toolResult.promise; return { content: "slow result" };
    } },
    { name: "never", description: "never", parameters: { type: "object" }, execute: async () => {
      secondExecutions += 1; return { content: "bad" };
    } },
  ];
  await core.send("tool-steer", "first");
  await toolStarted.promise;
  await core.send("tool-steer", "second");
  toolResult.resolve();
  await core.idle("tool-steer");
  const snapshot = await core.get("tool-steer");
  assert.equal(secondExecutions, 0);
  assert.ok(snapshot.events.some((event) => event.type === "user" && event.content === "second"));
  assert.equal(snapshot.events.find((event) => event.type === "tool_result" && event.data?.toolCallId === "never")?.data?.cancelled, true);
});

test("uncertain write survives new sends and blocks progress until reconciliation", async () => {
  let modelCalls = 0;
  const { core, deps } = concurrencyHarness({ complete: async () => {
    modelCalls += 1;
    return modelCalls === 1
      ? { toolCalls: [{ id: "maybe", name: "maybe", arguments: {} }] }
      : { content: "done after readback" };
  } });
  deps.tools = [{ name: "maybe", description: "maybe", parameters: { type: "object" }, write: true, requiresApproval: false,
    execute: async () => ({ content: "unknown", uncertainWrite: true }) }];
  await core.send("uncertain-send", "start");
  await core.idle("uncertain-send");
  await core.send("uncertain-send", "adjust");
  await new Promise((done) => setImmediate(done));
  let snapshot = await core.get("uncertain-send");
  assert.equal(snapshot.run?.status, "paused");
  assert.ok(snapshot.uncertainWrite);
  assert.equal(modelCalls, 1);
  deps.reconcileUncertainWrite = async () => ({ reconciled: true, message: "read back" });
  await core.resume("uncertain-send");
  await core.idle("uncertain-send");
  snapshot = await core.get("uncertain-send");
  assert.equal(snapshot.run?.status, "completed");
  assert.equal(modelCalls, 2);
});

test("same product fingerprint cannot reuse an approval after a new user intent", async () => {
  const results: AgentModelResult[] = [
    { toolCalls: [{ id: "approve", name: "request_approval", arguments: { scope: ["write"], summary: "write" } }] },
    { toolCalls: [{ id: "hold", name: "ask_user", arguments: { questions: [{ id: "x", label: "X", kind: "text" }] } }] },
    { toolCalls: [{ id: "write", name: "write", arguments: {} }] },
    { content: "done" },
  ];
  const { core, deps } = concurrencyHarness({ complete: async () => results.shift() ?? { content: "done" } });
  let writes = 0;
  deps.tools = [{ name: "write", description: "write", parameters: { type: "object" }, write: true,
    approvalScope: ["write"], execute: async () => { writes += 1; return { content: "written" }; } }];
  await core.send("approval", "first");
  await core.idle("approval");
  let snapshot = await core.get("approval");
  await core.approve("approval", { approvalId: snapshot.pendingApproval!.id, productVersion: snapshot.pendingApproval!.productVersion });
  await core.idle("approval");
  snapshot = await core.get("approval");
  assert.equal(snapshot.run?.status, "waiting_input");
  await core.send("approval", "changed intent");
  await core.idle("approval");
  assert.equal(writes, 0);
  assert.ok((await core.get("approval")).events.some((event) => /需要当前意图/.test(event.content)));
});

test("approval rechecks its business precondition before becoming valid", async () => {
  const { core, deps } = concurrencyHarness({ complete: async () => ({
    toolCalls: [{ id: "approval", name: "request_approval", arguments: { scope: ["write"], summary: "write" } }],
  }) });
  let blocked = false;
  deps.approvalPrecondition = async () => blocked ? "产品已变化" : undefined;
  await core.send("approval-precondition", "start");
  await core.idle("approval-precondition");
  const waiting = await core.get("approval-precondition");
  blocked = true;
  const result = await core.approve("approval-precondition", {
    approvalId: waiting.pendingApproval!.id,
    productVersion: waiting.pendingApproval!.productVersion,
  });
  assert.equal(result.pendingApproval, undefined);
  assert.ok(result.events.some((event) => /前置条件已变化/.test(event.content)));
});

test("paused approvals can return to waiting and failed runs can resume", async () => {
  const results: AgentModelResult[] = [
    { toolCalls: [{ id: "approval", name: "request_approval", arguments: { scope: ["x"], summary: "x" } }] },
    { content: "approved" },
  ];
  const { core } = concurrencyHarness({ complete: async () => results.shift() ?? { content: "done" } });
  await core.send("paused-approval", "start");
  await core.idle("paused-approval");
  await core.pause("paused-approval");
  assert.equal((await core.resume("paused-approval")).run?.status, "waiting_approval");
  const waiting = await core.get("paused-approval");
  await core.approve("paused-approval", { approvalId: waiting.pendingApproval!.id, productVersion: waiting.pendingApproval!.productVersion });
  await core.idle("paused-approval");
  assert.equal((await core.get("paused-approval")).run?.status, "completed");

  let attempts = 0;
  const failed = concurrencyHarness({ complete: async () => {
    attempts += 1;
    if (attempts === 1) throw new Error("bad request");
    return { content: "recovered" };
  } });
  await failed.core.send("failed", "start");
  await failed.core.idle("failed");
  assert.equal((await failed.core.get("failed")).run?.status, "failed");
  await failed.core.resume("failed");
  await failed.core.idle("failed");
  assert.equal((await failed.core.get("failed")).run?.status, "completed");
});

test("transient model errors retry twice and store snapshots defensively", async () => {
  let attempts = 0;
  let stored: AgentSnapshot | undefined;
  const deps: AgentCoreDependencies = {
    model: { complete: async () => {
      attempts += 1;
      if (attempts < 3) throw Object.assign(new Error("busy"), { status: 503 });
      return { content: "done" };
    } },
    tools: [],
    accountFor: async () => ({ accountKey: "a", productVersion: "v" }),
    id: (() => { let index = 0; return () => `id-${++index}`; })(),
  };
  const core = new AgentCore(deps, {
    getAgentSnapshot: () => stored,
    saveAgentSnapshot: (snapshot) => { stored = snapshot; },
  });
  const returned = await core.send("clone", "start");
  returned.events.push({ id: "outside", runId: "bad", type: "user", createdAt: "x", content: "mutated" });
  await core.idle("clone");
  assert.equal(attempts, 3);
  assert.ok(stored?.events.every((event) => event.id !== "outside"));
  const loaded = await core.get("clone");
  loaded.events.length = 0;
  assert.ok((await core.get("clone")).events.length > 0);
});

test("model resolution failures are persisted and remain resumable", async () => {
  let resolutions = 0;
  const { core, deps } = concurrencyHarness(undefined);
  deps.modelFor = async () => {
    resolutions += 1;
    if (resolutions === 1) throw new Error("missing configuration");
    return { complete: async () => ({ content: "recovered" }) };
  };
  await core.send("model-for", "start");
  await core.idle("model-for");
  assert.equal((await core.get("model-for")).run?.status, "failed");
  await core.resume("model-for");
  await core.idle("model-for");
  assert.equal((await core.get("model-for")).run?.status, "completed");
});

test("restart treats a dispatched external write without a result as uncertain and never replays it", async () => {
  let stored: AgentSnapshot | undefined = {
    localProductId: "restart-write",
    run: { id: "run", status: "running", createdAt: "x", updatedAt: "x", intentVersion: "intent" },
    events: [
      { id: "user", runId: "run", type: "user", createdAt: "x", content: "write" },
      { id: "call", runId: "run", type: "tool_call", createdAt: "x", content: "write", data: { toolCallId: "write-1", name: "write", arguments: {} } },
      { id: "dispatch", runId: "run", type: "status", createdAt: "x", content: "dispatched",
        data: { writeDispatch: true, toolCallId: "write-1", name: "write", arguments: {} } },
    ],
  };
  let modelCalls = 0;
  let writes = 0;
  const deps: AgentCoreDependencies = {
    model: { complete: async () => { modelCalls += 1; return { toolCalls: [{ id: "write-1", name: "write", arguments: {} }] }; } },
    tools: [{ name: "write", description: "write", parameters: { type: "object" }, write: true,
      execute: async () => { writes += 1; return { content: "written" }; } }],
    accountFor: async () => ({ accountKey: "account", productVersion: "version" }),
  };
  const core = new AgentCore(deps, {
    getAgentSnapshot: () => stored,
    saveAgentSnapshot: (snapshot) => { stored = structuredClone(snapshot); },
  });
  const recovered = await core.get("restart-write");
  assert.equal(recovered.run?.status, "paused");
  assert.equal(recovered.uncertainWrite?.toolCallId, "write-1");
  await core.resume("restart-write");
  await core.idle("restart-write");
  assert.equal((await core.get("restart-write")).run?.status, "paused");
  assert.equal(modelCalls, 0);
  assert.equal(writes, 0);
});

test("restart closes an interrupted tool group only after authoritative reconciliation", async () => {
  let stored: AgentSnapshot | undefined = {
    localProductId: "restart-group",
    run: { id: "run", status: "running", createdAt: "x", updatedAt: "x", intentVersion: "intent" },
    events: [
      { id: "user", runId: "run", type: "user", createdAt: "x", content: "write" },
      { id: "call-1", runId: "run", type: "tool_call", createdAt: "x", content: "write",
        data: { modelTurnId: "turn", toolCallId: "write-1", name: "write", arguments: {}, index: 0, count: 2 } },
      { id: "call-2", runId: "run", type: "tool_call", createdAt: "x", content: "read",
        data: { modelTurnId: "turn", toolCallId: "read-2", name: "read", arguments: {}, index: 1, count: 2 } },
      { id: "dispatch", runId: "run", type: "status", createdAt: "x", content: "dispatched",
        data: { writeDispatch: true, toolCallId: "write-1", name: "write", arguments: {} } },
    ],
  };
  const inputs: AgentModelMessage[][] = [];
  let executions = 0;
  const deps: AgentCoreDependencies = {
    model: { complete: async (input) => { inputs.push(input.messages); return { content: "done" }; } },
    tools: [{ name: "write", description: "write", parameters: {}, write: true,
      execute: async () => { executions += 1; return { content: "bad" }; } }],
    accountFor: async () => ({ accountKey: "account", productVersion: "version" }),
    reconcileUncertainWrite: async () => ({ reconciled: true, message: "权威读回确认成功" }),
  };
  const core = new AgentCore(deps, {
    getAgentSnapshot: () => stored,
    saveAgentSnapshot: (snapshot) => { stored = structuredClone(snapshot); },
  });
  await core.get("restart-group");
  await core.resume("restart-group");
  await core.idle("restart-group");
  const snapshot = await core.get("restart-group");
  assert.equal(executions, 0);
  assert.equal(snapshot.run?.status, "completed");
  assert.equal(snapshot.events.find((event) => event.type === "tool_result"
    && event.data?.toolCallId === "read-2")?.data?.cancelled, true);
  const history = inputs[0]!.slice(1);
  assert.deepEqual(history.map((message) => message.role), ["user", "assistant", "tool", "tool"]);
  assert.deepEqual(history.slice(2).map((message) => message.toolCallId), ["write-1", "read-2"]);
});
