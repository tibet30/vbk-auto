import assert from "node:assert/strict";
import test from "node:test";
import { AgentCore } from "../../src/main/agent/core.js";
import { PRODUCT_PREPARATION_INSTRUCTION } from "../../src/main/agent/preparation-run.js";
import type { AgentModelResult } from "../../src/main/agent/types.js";
import { buildProductSnapshot } from "../../src/main/infrastructure/database/parts/product-draft.js";
import type { AgentSnapshot, ProductDetail } from "../../src/shared/contracts.js";

function product(): ProductDetail {
  const value = buildProductSnapshot({ destination: "潮州", days: 2, productForm: "privateTour" });
  Object.assign(value.product.basicInfo!, { province: "广东", subtitle: "潮州两日私家团", operationNotes: "按用户日程安排" });
  Object.assign(value.product.operations!, { pickupCity: "潮州", transport: "charter" });
  return value;
}

test("修复窗口中的只读状态问询不关闭无选项 confirm 自动恢复", async () => {
  const current = product();
  const snapshots = new Map<string, AgentSnapshot>();
  let modelStarted!: () => void;
  const started = new Promise<void>((resolve) => { modelStarted = resolve; });
  let resolveModel!: (result: AgentModelResult) => void;
  const deferred = new Promise<AgentModelResult>((resolve) => { resolveModel = resolve; });
  const core = new AgentCore({
    model: { complete: async () => { modelStarted(); return deferred; } },
    tools: [{ name: "generate_product_module", description: "generate", parameters: {}, write: true, requiresApproval: false,
      execute: async () => ({ content: "still missing" }) }],
    accountFor: async () => ({ accountKey: "local", productVersion: "v1" }),
    preparationProduct: () => current,
    requiresCompletionVerification: () => true,
    finishVerified: async () => ({ verified: true }),
  }, { getAgentSnapshot: (id) => snapshots.get(id), saveAgentSnapshot: (snapshot) => snapshots.set(snapshot.localProductId, structuredClone(snapshot)) });

  await core.send(current.id, PRODUCT_PREPARATION_INSTRUCTION);
  await started;
  await core.send(current.id, "卡在哪？");
  resolveModel({ toolCalls: [{ id: "confirm", name: "ask_user", arguments: { questions: [{
    id: "repair-confirm", label: "是否继续重试", kind: "confirm",
  }] } }] });
  await core.idle(current.id);
  const snapshot = await core.get(current.id);
  assert.equal(snapshot.events.some((event) => event.type === "input_request"), false);
  assert.equal(snapshot.pendingInput, undefined);
  assert.equal(snapshot.events.some((event) => event.data?.defaultAnswers
    && (event.data.defaultAnswers as Record<string, unknown>)["repair-confirm"] === "true"), true);
  assert.equal(snapshot.run?.status, "paused");
  assert.equal(snapshot.events.some((event) => /自动尝试 2 次且模型修复一次/.test(event.content)), true);
});
