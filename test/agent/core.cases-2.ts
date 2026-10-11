import assert from "node:assert/strict";
import test from "node:test";
import { AgentCore, isPendingApprovalStatusFollowup, preservesApprovedIntent } from "../../src/main/agent/core.js";
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

test("resuming a paused approved workflow hands control back to the deterministic runner", async () => {
  const { core, saved, deps } = harness([]);
  let handoffs = 0;
  deps.handoffApprovedWorkflow = () => { handoffs += 1; return true; };
  saved.set("handoff-resume", {
    localProductId: "handoff-resume",
    run: { id: "run", status: "paused", createdAt: "x", updatedAt: "x", intentVersion: "intent" },
    events: [{ id: "approval-event", runId: "run", type: "approval", content: "用户已授权", createdAt: "x", data: {
      approval: { id: "approval", productVersion: "version", accountKey: "account", intentVersion: "intent",
        scope: ["vbk.write_phase:basic"], summary: "录入", status: "approved", createdAt: "x" },
    }}],
  });

  await core.resume("handoff-resume");
  await core.idle("handoff-resume");
  assert.equal(handoffs, 1);
});
test("phase-B resume refuses a changed plan without refreshing authority or calling the model", async () => {
  const { core, saved, deps } = harness([{ content: "model must not run" }]);
  let handoffs = 0;
  let modelCalls = 0;
  deps.accountFor = async () => ({ accountKey: "account", productVersion: "post-failure-version" });
  deps.model = { complete: async () => { modelCalls += 1; return { content: "model must not run" }; } };
  deps.handoffApprovedWorkflow = () => { handoffs += 1; return true; };
  saved.set("phase-b-resume", {
    localProductId: "phase-b-resume",
    run: { id: "run", status: "paused", createdAt: "x", updatedAt: "x", intentVersion: "intent", error: "自动录入已暂停：网络超时" },
    events: [{ id: "approval-event", runId: "run", type: "approval", content: "用户已授权", createdAt: "x", data: {
      approval: { id: "approval", productVersion: "pre-write-version", accountKey: "account", intentVersion: "intent",
        scope: ["vbk.write_phase:basic", "vbk.write_phase:preflight"], summary: "录入", status: "approved", createdAt: "x" },
    }}],
  });

  const resumed = await core.resume("phase-b-resume");
  await core.idle("phase-b-resume");
  assert.equal(handoffs, 0);
  assert.equal(modelCalls, 0);
  const approval = resumed.events.find((event) => event.type === "approval")?.data?.approval as { productVersion?: string } | undefined;
  assert.equal(approval?.productVersion, "pre-write-version");
  assert.equal(resumed.run?.status, "paused");
});

test("phase-B resume stays paused when deterministic handoff cannot start", async () => {
  const { core, saved, deps } = harness([{ content: "model must not run" }]);
  let modelCalls = 0;
  deps.model = { complete: async () => { modelCalls += 1; return { content: "model must not run" }; } };
  deps.handoffApprovedWorkflow = () => false;
  saved.set("phase-b-handoff-fail", {
    localProductId: "phase-b-handoff-fail",
    run: { id: "run", status: "paused", createdAt: "x", updatedAt: "x", intentVersion: "intent" },
    events: [{ id: "approval-event", runId: "run", type: "approval", content: "用户已授权", createdAt: "x", data: {
      approval: { id: "approval", productVersion: "version", accountKey: "account", intentVersion: "intent",
        scope: ["vbk.write_phase:basic"], summary: "录入", status: "approved", createdAt: "x" },
    }}],
  });

  const next = await core.resume("phase-b-handoff-fail");
  await core.idle("phase-b-handoff-fail");
  assert.equal(next.run?.status, "paused");
  assert.ok(next.events.some((event) => event.type === "status" && /不会改回 AI 规划/.test(event.content)));
  assert.equal(modelCalls, 0);
});

test("recovery wording after a phase-B pause restarts the deterministic runner", async () => {
  const { core, saved, deps } = harness([{ content: "model must not run" }]);
  let handoffs = 0;
  let modelCalls = 0;
  deps.model = { complete: async () => { modelCalls += 1; return { content: "model must not run" }; } };
  deps.handoffApprovedWorkflow = () => { handoffs += 1; return true; };
  saved.set("phase-b-recovery-send", {
    localProductId: "phase-b-recovery-send",
    run: { id: "run", status: "paused", createdAt: "x", updatedAt: "x", intentVersion: "intent" },
    events: [{ id: "approval-event", runId: "run", type: "approval", content: "用户已授权", createdAt: "x", data: {
      approval: { id: "approval", productVersion: "version", accountKey: "account", intentVersion: "intent",
        scope: ["vbk.write_phase:basic"], summary: "录入", status: "approved", createdAt: "x" },
    }}],
  });

  await core.send("phase-b-recovery-send", "从报错处继续执行");
  await core.idle("phase-b-recovery-send");
  assert.equal(handoffs, 1);
  assert.equal(modelCalls, 0);
});

test("pauseApprovedWorkflow preserves the old fingerprint when business data changed", async () => {
  const { core, saved, deps } = harness([]);
  deps.accountFor = async () => ({ accountKey: "account", productVersion: "after-partial-write" });
  saved.set("phase-b-pause", {
    localProductId: "phase-b-pause",
    run: { id: "run", status: "running", createdAt: "x", updatedAt: "x", intentVersion: "intent" },
    events: [{ id: "approval-event", runId: "run", type: "approval", content: "用户已授权", createdAt: "x", data: {
      approval: { id: "approval", productVersion: "before-write", accountKey: "account", intentVersion: "intent",
        scope: ["vbk.write_phase:basic"], summary: "录入", status: "approved", createdAt: "x" },
    }}],
  });

  const paused = await core.pauseApprovedWorkflow("phase-b-pause", "approval", "VBK 超时");
  assert.equal(paused.run?.status, "paused");
  const approval = paused.events.find((event) => event.type === "approval")?.data?.approval as { productVersion?: string } | undefined;
  assert.equal(approval?.productVersion, "before-write");
});

test("AgentCore persists tool-call/result pairing and completes a read-only run", async () => {
  const { core } = harness([{ toolCalls: [{ id: "call-1", name: "read", arguments: {} }] }, { content: "finished" }]);
  await core.send("product-1", "开始"); await core.idle("product-1"); const result = await core.get("product-1");
  assert.equal(result.run?.status, "completed");
  assert.deepEqual(result.events.filter((event) => event.type === "tool_call" || event.type === "tool_result").map((event) => event.data?.toolCallId), ["call-1", "call-1"]);
  assert.ok(result.events.some((event) => event.type === "assistant" && event.data?.generatedToolPreamble === true
    && /read，继续推进当前产品任务/.test(event.content)));
});

test("AgentCore holds user input durably and resumes with a paired tool result", async () => {
  const { core } = harness([{ toolCalls: [{ id: "ask-1", name: "ask_user", arguments: { questions: [{ id: "city", label: "城市", kind: "text", required: true }] } }] }, { content: "finished" }]);
  await core.send("product-2", "规划"); await core.idle("product-2"); const waiting = await core.get("product-2");
  assert.equal(waiting.run?.status, "waiting_input");
  await core.respond("product-2", { requestId: waiting.pendingInput!.id, answers: { city: "成都" } }); await core.idle("product-2"); const done = await core.get("product-2");
  assert.equal(done.run?.status, "completed");
  assert.ok(done.events.some((event) => event.type === "tool_result" && event.data?.toolCallId === "ask-1"));
});

test("AgentCore rejects commercial-pricing questions and leaves the run available for automatic generation", async () => {
  const { core } = harness([
    { toolCalls: [{ id: "ask-price", name: "ask_user", arguments: { questions: [
      { id: "adult_price", label: "本地成人价", kind: "text", required: true },
      { id: "child_price", label: "儿童价", kind: "text" },
      { id: "min_people", label: "起订人数", kind: "text" },
    ] } }] },
    { content: "已转为自动估价" },
  ]);

  await core.send("automatic-pricing", "规划");
  await core.idle("automatic-pricing");
  const done = await core.get("automatic-pricing");
  const result = done.events.find((event) => event.type === "tool_result" && event.data?.toolCallId === "ask-price");
  assert.equal(done.pendingInput, undefined);
  assert.equal(done.run?.status, "completed");
  assert.equal(result?.data?.automaticCommercialPricing, true);
  assert.match(result?.content ?? "", /generate_product_module/);
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

test("AgentCore resolves inferable preparation questions and defers VBK approval to the final gate", async () => {
  const { core } = harness([
    { toolCalls: [{ id: "ask-preparation", name: "ask_user", arguments: { questions: [
      { id: "pickup_city", label: "出发地 pickupCity 用哪个城市？", kind: "single", required: true, options: [
        { id: "rikaze", label: "日喀则" }, { id: "other", label: "其他城市" },
      ] },
      { id: "choice", label: "D2 上午二选一怎么处理？", kind: "single", required: true, options: [
        { id: "one", label: "只保留第一项" }, { id: "both", label: "同时保留两个 relation=or" },
      ] },
      { id: "station", label: "接站与送站的火车站端点？", kind: "single", required: true, options: [
        { id: "default", label: "日喀则站（默认）" }, { id: "other", label: "其他火车站" },
      ] },
      { id: "approval_scope", label: "是否授权本地到 VBK 写入范围？", kind: "multiple", required: true, options: [
        { id: "basic", label: "基础信息" }, { id: "itinerary", label: "行程" },
      ] },
    ] } }] },
    { content: "继续自动准备" },
  ]);

  await core.send("preparation-defaults", "规划");
  await core.idle("preparation-defaults");
  const done = await core.get("preparation-defaults");
  assert.equal(done.pendingInput, undefined);
  const result = done.events.find((event) => event.type === "tool_result" && event.data?.toolCallId === "ask-preparation");
  assert.equal(result?.content, JSON.stringify({
    pickup_city: "rikaze",
    choice: "both",
    station: "default",
    approval_scope: [],
  }));
  assert.deepEqual(result?.data?.deferredApprovalQuestions, ["approval_scope"]);
});

test("AgentCore removes an inferred lodging node from itinerary spots without asking", async () => {
  const setup = harness([{
    toolCalls: [{
      id: "ask-travel-node",
      name: "ask_user",
      arguments: {
        questions: [{
          id: "travel_node",
          label: "如何处理日喀则（入住）这一非景点 POI",
          kind: "single",
          required: true,
          options: [
            { id: "remove", label: "移出景点列表" },
            { id: "keep", label: "保留并标注为住宿节点" },
          ],
        }],
      },
    }],
  }, { content: "done" }]);

  await setup.core.send("p1", "继续准备");
  await setup.core.idle("p1");

  const snapshot = await setup.core.get("p1");
  assert.equal(snapshot.pendingInput, undefined);
  const result = snapshot.events.find((event) => event.type === "tool_result" && event.data?.toolCallId === "ask-travel-node");
  assert.match(result?.content ?? "", /"travel_node":"remove"/);
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
