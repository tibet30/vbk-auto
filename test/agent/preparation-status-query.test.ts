import assert from "node:assert/strict";
import test from "node:test";
import { AgentCore } from "../../src/main/agent/core.js";
import { nextPreparationLoopDecision } from "../../src/main/agent/core-preparation.js";
import { PRODUCT_PREPARATION_INSTRUCTION } from "../../src/main/agent/preparation-run.js";
import { buildProductSnapshot } from "../../src/main/infrastructure/database/parts/product-draft.js";
import type { AgentSnapshot } from "../../src/shared/contracts.js";

function product() {
  const value = buildProductSnapshot({ destination: "潮州", days: 2, productForm: "privateTour" });
  Object.assign(value.product.basicInfo!, { province: "广东", subtitle: "潮州两日私家团", operationNotes: "按用户日程安排" });
  Object.assign(value.product.operations!, { pickupCity: "潮州", transport: "charter" });
  return value;
}

function snapshot(status: AgentSnapshot["run"] extends infer T ? T : never): AgentSnapshot {
  return { localProductId: "status", run: status, pendingInput: {
    id: "input", createdAt: "now", questions: [{ id: "poi", label: "请确认 POI", kind: "text", required: true }],
  }, events: [
    { id: "preparation", runId: status!.id, type: "user", content: PRODUCT_PREPARATION_INSTRUCTION, createdAt: "now" },
    { id: "blocked", runId: status!.id, type: "status", content: "等待 POI 核验", createdAt: "now" },
  ] };
}

test("暂停中的 preparation 纯状态查询只写可读事件，继续指令仍是新意图", async () => {
  let saved = snapshot({ id: "run", status: "paused", intentVersion: "v", createdAt: "now", updatedAt: "now" });
  let modelCalls = 0;
  const core = new AgentCore({
    model: { complete: async () => { modelCalls += 1; return { content: "已收到继续指令" }; } },
    tools: [], accountFor: async () => ({ accountKey: "a", productVersion: "v" }),
    preparationProduct: () => product(),
  }, { getAgentSnapshot: () => saved, saveAgentSnapshot: (next) => { saved = structuredClone(next); } });

  await core.send("status", "当前进度如何？");
  assert.equal(saved.run?.status, "paused");
  assert.equal(saved.pendingInput?.id, "input");
  assert.equal(modelCalls, 0);
  assert.equal(saved.events.at(-2)?.data?.readOnlyStatusQuery, true);
  assert.match(saved.events.at(-1)?.content ?? "", /当前节点/);

  await core.send("status", "继续完成本地规划与资源核验");
  const continuation = [...saved.events].reverse().find((event) => event.type === "user");
  assert.equal(continuation?.data?.readOnlyStatusQuery, undefined);
  assert.equal(continuation?.content, "继续完成本地规划与资源核验");
});

test("运行中的纯状态查询不清除同一语义进度的两次自动预算", async () => {
  const current = snapshot({ id: "run", status: "running", intentVersion: "v", createdAt: "now", updatedAt: "now" });
  current.pendingInput = undefined;
  for (const index of [1, 2]) {
    current.events.push({ id: `call-${index}`, runId: "run", type: "tool_call", content: "generate_product_module", createdAt: "now", data: {
      toolCallId: `call-${index}`, name: "generate_product_module", arguments: { stage: "itinerary" }, deterministicPreparation: true, progressKey: "not-current",
    } });
    current.events.push({ id: `result-${index}`, runId: "run", type: "tool_result", content: "没有变化", createdAt: "now", data: { toolCallId: `call-${index}` } });
  }
  const currentProduct = product();
  // Derive the real key from a first decision, then assign it to both persisted calls.
  const first = nextPreparationLoopDecision({ tools: [], accountFor: async () => ({ accountKey: "a", productVersion: "v" }), preparationProduct: () => currentProduct }, current);
  assert.equal(first.kind, "execute");
  for (const event of current.events) if (event.type === "tool_call") event.data!.progressKey = first.action.progressKey;
  let saved = structuredClone(current);
  const core = new AgentCore({ tools: [], accountFor: async () => ({ accountKey: "a", productVersion: "v" }), preparationProduct: () => currentProduct },
    { getAgentSnapshot: () => saved, saveAgentSnapshot: (next) => { saved = structuredClone(next); } });

  await core.send("status", "卡在哪？");
  const after = nextPreparationLoopDecision({ tools: [], accountFor: async () => ({ accountKey: "a", productVersion: "v" }), preparationProduct: () => currentProduct }, saved);
  assert.equal(after.kind, "model");
  assert.equal(after.modelRepairWindow, true);
  assert.equal(saved.events.at(-2)?.data?.readOnlyStatusQuery, true);
});

test("模型修复读取产品后还有执行机会，连续三轮只读才暂停", () => {
  const current = snapshot({ id: "run", status: "running", intentVersion: "v", createdAt: "now", updatedAt: "now" });
  current.pendingInput = undefined;
  const deps = { tools: [], accountFor: async () => ({ accountKey: "a", productVersion: "v" }), preparationProduct: () => product() };
  const first = nextPreparationLoopDecision(deps, current);
  assert.equal(first.kind, "execute");
  if (first.kind !== "execute") return;
  for (const i of [1, 2]) current.events.push({ id: `auto${i}`, runId: "run", type: "tool_call", content: "", createdAt: "now", data: { name: first.action.name, progressKey: first.action.progressKey, deterministicPreparation: true } });
  current.events.push({ id: "repair", runId: "run", type: "status", content: "", createdAt: "now", data: { name: first.action.name, progressKey: first.action.progressKey, deterministicPreparationModelRepair: true } });
  for (const i of [1, 2, 3]) {
    current.events.push({ id: `read${i}`, runId: "run", type: "tool_call", content: "", createdAt: "now", data: { name: "read_product", toolCallId: `read${i}` } });
    current.events.push({ id: `result${i}`, runId: "run", type: "tool_result", content: "当前产品", createdAt: "now", data: { toolCallId: `read${i}` } });
    assert.equal(nextPreparationLoopDecision(deps, current).kind, i < 3 ? "model" : "pause");
  }
});

test("一轮并行查询三个地点后仍有应用结果的机会，三轮无进展才暂停", () => {
  const current = snapshot({ id: "run", status: "running", intentVersion: "v", createdAt: "now", updatedAt: "now" });
  current.pendingInput = undefined;
  const deps = { tools: [], accountFor: async () => ({ accountKey: "a", productVersion: "v" }), preparationProduct: () => product() };
  const first = nextPreparationLoopDecision(deps, current);
  if (first.kind !== "execute") throw new Error("expected preparation action");
  for (const i of [1, 2]) current.events.push({ id: `auto${i}`, runId: "run", type: "tool_call", content: "", createdAt: "now", data: { name: first.action.name, progressKey: first.action.progressKey, deterministicPreparation: true } });
  current.events.push({ id: "repair", runId: "run", type: "status", content: "", createdAt: "now", data: { name: first.action.name, progressKey: first.action.progressKey, deterministicPreparationModelRepair: true } });
  for (const round of [1, 2, 3]) {
    for (const i of [1, 2, 3]) current.events.push({ id: `query-${round}-${i}`, runId: "run", type: "tool_call", content: "", createdAt: "now", data: { name: "query_poi", modelTurnId: `turn-${round}`, toolCallId: `query-${round}-${i}` } });
    for (const index of [1, 2]) current.events.push({ id: `usage-${round}-${index}`, runId: "run", type: "status", content: "", createdAt: "now", data: { aiUsage: { source: "planning.generate" } } });
    assert.equal(nextPreparationLoopDecision(deps, current).kind, round < 3 ? "model" : "pause");
  }
});
