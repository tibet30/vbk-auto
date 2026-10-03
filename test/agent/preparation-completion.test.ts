import assert from "node:assert/strict";
import test from "node:test";
import { AgentCore } from "../../src/main/agent/core.js";
import { agentWorkflowPatch } from "../../src/main/agent/integration-workflow.js";
import { agentCompletionGate } from "../../src/main/agent/integration-gates.js";
import { buildProductSnapshot } from "../../src/main/infrastructure/database/parts/product-draft.js";
import { isPreparationRun, PRODUCT_PREPARATION_INSTRUCTION } from "../../src/main/agent/preparation-run.js";
import type { AgentCoreDependencies, AgentModelMessage, AgentModelResult } from "../../src/main/agent/types.js";
import type { AgentSnapshot } from "../../src/shared/contracts.js";

function harness(results: AgentModelResult[]) {
  const saved = new Map<string, AgentSnapshot>();
  const inputs: AgentModelMessage[][] = [];
  const deps: AgentCoreDependencies = {
    model: { complete: async (input) => {
      inputs.push(structuredClone(input.messages));
      return results.shift() ?? { content: "请回复继续" };
    } },
    tools: [{ name: "read_product", description: "read", parameters: {},
      execute: async () => ({ content: "行程为空，准备未完成" }) }],
    accountFor: async () => ({ accountKey: "account", productVersion: "version" }),
    requiresCompletionVerification: (_id, snapshot) => isPreparationRun(snapshot),
    finishVerified: async () => ({ verified: false, message: "缺少行程、套餐和定价" }),
  };
  const core = new AgentCore(deps, {
    getAgentSnapshot: (id) => saved.get(id),
    saveAgentSnapshot: (snapshot) => saved.set(snapshot.localProductId, structuredClone(snapshot)),
  });
  return { core, deps, inputs, saved };
}

test("creation read-only reply receives execution feedback and repeated stalling pauses", async () => {
  const { core, inputs, deps, saved } = harness([
    { toolCalls: [{ id: "read", name: "read_product", arguments: {} }] },
    { content: "已读取，回复继续才开始规划" },
  ]);
  const product = buildProductSnapshot({ destination: "日喀则", days: 3, productForm: "privateTour" });
  deps.finishVerified = async (id, context) => agentCompletionGate(product, saved.get(id),
    { ready: false, completion: 0, issues: [] }, context);
  await core.send("creation", PRODUCT_PREPARATION_INSTRUCTION);
  await core.idle("creation");
  const snapshot = await core.get("creation");
  assert.equal(snapshot.run?.status, "paused");
  assert.equal(snapshot.pendingApproval, undefined);
  assert.ok(inputs.slice(2).some((messages) => messages.some((message) => /用户已授权本地规划/.test(message.content))));
  assert.ok(!snapshot.events.some((event) => event.data?.status === "completed"));
  const patch = agentWorkflowPatch(snapshot, product);
  assert.equal(patch.status, "needs_attention");
  assert.ok(patch.progress! < 100);
});

test("a stalled preparation can continue tools and reach final approval", async () => {
  const { core, deps } = harness([
    { content: "请回复继续" },
    { toolCalls: [{ id: "generate", name: "generate", arguments: {} }] },
    { content: "准备好了" },
  ]);
  let prepared = false;
  deps.tools.push({ name: "generate", description: "plan", parameters: {}, write: true, requiresApproval: false,
    execute: async () => { prepared = true; return { content: "saved", data: { changedSections: ["itinerary"] } }; } });
  deps.finishVerified = async () => prepared
    ? { verified: false, finalApproval: { scope: ["vbk.write_phase:basic"], summary: "确认录入" } }
    : { verified: false, message: "请生成行程" };
  await core.send("retry", PRODUCT_PREPARATION_INSTRUCTION);
  await core.idle("retry");
  const snapshot = await core.get("retry");
  assert.equal(prepared, true);
  assert.equal(snapshot.run?.status, "waiting_approval");
  assert.ok(snapshot.pendingApproval);
});

test("preexisting ready preparation keeps final approval even without writes in this run", async () => {
  const { core, deps } = harness([{ content: "准备完成" }]);
  deps.finishVerified = async () => ({ verified: false,
    finalApproval: { scope: ["vbk.write_phase:basic"], summary: "确认录入" } });
  await core.send("ready", "继续完成本地规划与资源核验");
  await core.idle("ready");
  const snapshot = await core.get("ready");
  assert.equal(snapshot.run?.status, "waiting_approval");
  assert.ok(snapshot.pendingApproval);
});

test("ordinary read-only query completes without invoking preparation gate", async () => {
  const { core, deps } = harness([{ content: "当前资料尚未完成" }]);
  deps.finishVerified = async () => { throw new Error("query must not enter preparation"); };
  await core.send("query", "当前进度如何？");
  await core.idle("query");
  assert.equal((await core.get("query")).run?.status, "completed");
});

test("historical completed conversations cannot project an unfinished product as success", () => {
  const product = buildProductSnapshot({ destination: "日喀则", days: 3, productForm: "privateTour" });
  const snapshot: AgentSnapshot = { localProductId: product.id, events: [],
    run: { id: "run", status: "completed", createdAt: "now", updatedAt: "now" } };
  const patch = agentWorkflowPatch(snapshot, product);
  assert.equal(patch.status, "needs_attention");
  assert.equal(patch.stage, "planning");
  assert.ok(patch.progress! < 100);
  assert.match(patch.message!, /产品尚未完成/);
  assert.equal(patch.completedAt, undefined);
  assert.equal(agentWorkflowPatch(snapshot).status, "needs_attention");
  product.status = "draft_saved";
  assert.equal(agentWorkflowPatch(snapshot, product).status, "needs_attention");
  product.productId = "79231895";
  assert.equal(agentWorkflowPatch(snapshot, product).status, "succeeded");
  assert.equal(agentWorkflowPatch(snapshot, product).progress, 100);
});

test("old preparation requests do not capture a new query run", () => {
  const snapshot: AgentSnapshot = { localProductId: "product", run: {
    id: "query", status: "running", createdAt: "now", updatedAt: "now" }, events: [{
    id: "old", runId: "old-run", type: "user", createdAt: "then", content: PRODUCT_PREPARATION_INSTRUCTION,
  }] };
  assert.equal(isPreparationRun(snapshot), false);
});

test("reading a legacy false completion restores a resumable checkpoint without starting work", async () => {
  const { core, inputs, saved } = harness([]);
  saved.set("legacy", { localProductId: "legacy", run: {
    id: "run", status: "completed", createdAt: "then", updatedAt: "then" }, events: [{
    id: "create", runId: "run", type: "user", createdAt: "then", content: PRODUCT_PREPARATION_INSTRUCTION,
  }] });
  const snapshot = await core.get("legacy");
  assert.equal(snapshot.run?.status, "paused");
  assert.equal(inputs.length, 0);
  assert.match(snapshot.events.at(-1)!.content, /已纠正提前结束状态/);
  await core.resume("legacy");
  await core.idle("legacy");
  assert.ok(inputs.length > 0);
  assert.equal((await core.get("legacy")).run?.status, "paused");
});
