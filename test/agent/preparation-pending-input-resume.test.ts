import assert from "node:assert/strict";
import test from "node:test";
import { AgentCore } from "../../src/main/agent/core.js";
import { PRODUCT_PREPARATION_INSTRUCTION } from "../../src/main/agent/preparation-run.js";
import type { AgentSnapshot } from "../../src/shared/contracts.js";
import { hasUnresolvedAgentToolFailure } from "../../src/shared/agent-tool-outcomes.js";

function waiting(id: string, preparation = true): AgentSnapshot {
  const question = { id: "poi", label: "请提供 POI", kind: "text" as const, required: true };
  return { localProductId: id, run: { id: "run", status: "waiting_input", createdAt: "t", updatedAt: "t" },
    pendingInput: { id: "request", questions: [question], createdAt: "t" }, events: [
      { id: "user", runId: "run", type: "user", content: preparation ? PRODUCT_PREPARATION_INSTRUCTION : "查询当前进度", createdAt: "t" },
      { id: "ask-call", runId: "run", type: "tool_call", content: "ask_user", createdAt: "t",
        data: { toolCallId: "ask", name: "ask_user", arguments: { questions: [question] } } },
      { id: "input", runId: "run", type: "input_request", content: "需要 POI", createdAt: "t",
        data: { toolCallId: "ask", request: { id: "request", questions: [question], createdAt: "t" } } },
    ] };
}

function harness(snapshot: AgentSnapshot, resolved: Array<{ id: string; message: string; answer?: string; pause?: boolean }>) {
  let saved = structuredClone(snapshot); let modelCalls = 0;
  const core = new AgentCore({
    model: { complete: async () => { modelCalls += 1; return { content: "本地规划已继续" }; } }, tools: [],
    accountFor: async () => ({ accountKey: "a", productVersion: "v" }),
    resolvedPendingQuestions: () => resolved,
    requiresCompletionVerification: (_id, current) => current.events.some((event) => event.runId === current.run?.id
      && event.type === "user" && event.content === PRODUCT_PREPARATION_INSTRUCTION),
    finishVerified: async () => ({ verified: false, finalApproval: { scope: ["vbk.write_phase:basic"], summary: "确认录入" } }),
  }, { getAgentSnapshot: () => saved, saveAgentSnapshot: (next) => { saved = structuredClone(next); } });
  return { core, current: () => saved, calls: () => modelCalls };
}

test("satisfied preparation input resumes the loop and reaches approval without another continue prompt", async () => {
  const snapshot = waiting("preparation");
  snapshot.pendingInput!.defaultAnswers = { poi: "宽窄巷子" };
  const { core, current, calls } = harness(snapshot, [{ id: "poi", message: "POI 已保存" }]);
  await core.reconcilePendingInput("preparation");
  await core.idle("preparation");
  assert.equal(calls(), 1);
  assert.equal(current().run?.status, "waiting_approval");
  assert.equal(current().pendingInput, undefined);
  const result = current().events.find((event) => event.type === "tool_result" && event.data?.automaticallyResumed === true);
  assert.equal(result?.data?.resolved, true);
  assert.equal(result?.data?.cancelled, undefined);
  assert.deepEqual(result?.data?.defaultAnswers, { poi: "宽窄巷子" });
  assert.equal(hasUnresolvedAgentToolFailure(current().events, "run"), false);
});

test("mixed satisfied input retains the unanswered question and does not schedule", async () => {
  const snapshot = waiting("mixed");
  snapshot.pendingInput!.questions.push({ id: "hotel", label: "请确认酒店", kind: "text", required: true });
  (snapshot.events[2]!.data!.request as { questions: unknown[] }).questions = snapshot.pendingInput!.questions;
  const { core, current, calls } = harness(snapshot, [{ id: "poi", message: "POI 已保存" }]);
  await core.reconcilePendingInput("mixed");
  assert.equal(calls(), 0);
  assert.equal(current().run?.status, "waiting_input");
  assert.deepEqual(current().pendingInput?.questions.map((question) => question.id), ["hotel"]);
  assert.equal(current().pendingInput?.defaultAnswers?.poi, "已在当前产品中保存");
});

for (const [name, preparation, pause, uncertain] of [
  ["manual pause", true, true, false], ["ordinary query", false, false, false], ["uncertain write", true, false, true],
] as const) {
  test(`${name} never auto-resumes a reconciled input`, async () => {
    const snapshot = waiting(name, preparation);
    if (uncertain) snapshot.uncertainWrite = { toolCallId: "write", message: "awaiting readback", createdAt: "t" };
    const { core, current, calls } = harness(snapshot, [{ id: "poi", message: "POI 已保存", ...(pause ? { pause: true } : {}) }]);
    await core.reconcilePendingInput(name);
    assert.equal(calls(), 0);
    assert.equal(current().run?.status, "paused");
  });
}

for (const name of ["approved intent", "remote write"] as const) {
  test(`${name} never re-enters model planning from an old reconciled input`, async () => {
    const snapshot = waiting(name);
    if (name === "approved intent") {
      snapshot.run!.intentVersion = "v:run";
      snapshot.events.push({ id: "approved", runId: "run", type: "approval", content: "已审批", createdAt: "t", data: {
        approval: { id: "approval", productVersion: "v", accountKey: "a", scope: ["vbk.write"], summary: "录入", status: "approved", createdAt: "t", intentVersion: "v:run" },
      } });
    } else {
      snapshot.events.push({ id: "remote", runId: "run", type: "tool_result", content: "已写入", createdAt: "t", data: { toolCallId: "write", remoteWrite: true } });
    }
    const { core, current, calls } = harness(snapshot, [{ id: "poi", message: "POI 已保存" }]);
    await core.reconcilePendingInput(name);
    assert.equal(calls(), 0);
    assert.equal(current().run?.status, "paused");
  });
}
