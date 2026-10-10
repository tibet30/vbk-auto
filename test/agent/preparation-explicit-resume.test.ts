import assert from "node:assert/strict";
import test from "node:test";
import { AgentCore } from "../../src/main/agent/core.js";
import { PRODUCT_PREPARATION_INSTRUCTION } from "../../src/main/agent/preparation-run.js";
import { buildProductSnapshot } from "../../src/main/infrastructure/database/parts/product-draft.js";
import type { AgentCoreDependencies } from "../../src/main/agent/types.js";
import type { AgentSnapshot, ProductDetail } from "../../src/shared/contracts.js";

function product(): ProductDetail {
  const value = buildProductSnapshot({ destination: "潮州", days: 2, productForm: "privateTour" });
  Object.assign(value.product.basicInfo!, { province: "广东", subtitle: "潮州两日私家团", operationNotes: "按用户日程安排" });
  Object.assign(value.product.operations!, { pickupCity: "潮州", transport: "charter", hotelTier: "当地5钻酒店/-38" });
  return value;
}

function saveItinerary(value: ProductDetail): void {
  value.product.itinerary = [
    { day: 1, title: "潮州古城", description: "游览广济桥", hotel: "无", meals: "自理", spots: [{ name: "广济桥", poiName: "广济桥", poiId: 101 }] },
    { day: 2, title: "南澳海岸", description: "游览南澳大桥", hotel: "无", meals: "自理", spots: [{ name: "南澳大桥", poiName: "南澳大桥", poiId: 102 }] },
  ];
}

function harness(value: ProductDetail, saveOnResume = false) {
  const snapshots = new Map<string, AgentSnapshot>();
  const calls: string[] = [];
  let modelCalls = 0;
  let allowSave = false;
  const deps: AgentCoreDependencies = {
    model: { complete: async () => { modelCalls += 1; return { content: "模型已检查，但尚未形成新的产品进展。" }; } },
    tools: [{ name: "generate_product_module", description: "generate", parameters: {}, write: true, requiresApproval: false,
      execute: async () => {
        calls.push("generate");
        if (saveOnResume && allowSave) {
          saveItinerary(value);
          return { content: "本地行程已保存" };
        }
        return { content: "仍缺少行程" };
      } }],
    accountFor: async () => ({ accountKey: "local", productVersion: "v1" }),
    preparationProduct: () => value,
    requiresCompletionVerification: () => true,
    finishVerified: async () => ({ verified: false }),
  };
  const core = new AgentCore(deps, {
    getAgentSnapshot: (id) => snapshots.get(id),
    saveAgentSnapshot: (snapshot) => snapshots.set(snapshot.localProductId, structuredClone(snapshot)),
  });
  return { core, calls, modelCalls: () => modelCalls, enableSave: () => { allowSave = true; },
    snapshot: () => snapshots.get(value.id)!, replace: (snapshot: AgentSnapshot) => snapshots.set(value.id, structuredClone(snapshot)) };
}

function pausedSnapshot(value: ProductDetail, preparation = true): AgentSnapshot {
  return { localProductId: value.id, run: { id: "run", status: "paused", createdAt: "t", updatedAt: "t", intentVersion: "v:run" }, events: [
    { id: "user", runId: "run", type: "user", content: preparation ? PRODUCT_PREPARATION_INSTRUCTION : "查询当前产品状态", createdAt: "t" },
    { id: "paused", runId: "run", type: "status", content: "运行已暂停", createdAt: "t", data: { status: "paused" } },
  ] };
}

test("准备运行的继续按钮写入一次控制事件并允许本地生成工具保存", async () => {
  const value = product();
  const h = harness(value, true);
  await h.core.send(value.id, PRODUCT_PREPARATION_INSTRUCTION);
  await h.core.idle(value.id);
  assert.equal(h.snapshot().run?.status, "paused");
  assert.deepEqual(h.calls, ["generate", "generate"]);
  assert.equal(h.modelCalls(), 3);

  h.enableSave();
  await h.core.resume(value.id);
  await h.core.idle(value.id);
  const resumed = h.snapshot();
  assert.ok(h.calls.length >= 3);
  assert.equal(value.product.itinerary?.length, 2);
  assert.equal(resumed.events.filter((event) => event.data?.preparationResume === true).length, 1);
  assert.equal(resumed.pendingApproval, undefined);
  assert.equal(resumed.events.some((event) => event.data?.remoteWrite === true), false);
});

test("状态查询不重开窗口，第二次无进展继续仍有界", async () => {
  const value = product();
  const h = harness(value);
  await h.core.send(value.id, PRODUCT_PREPARATION_INSTRUCTION);
  await h.core.idle(value.id);
  assert.equal(h.snapshot().run?.status, "paused");
  await h.core.get(value.id);
  await h.core.send(value.id, "当前进度");
  await h.core.idle(value.id);
  assert.deepEqual(h.calls, ["generate", "generate"]);
  assert.equal(h.snapshot().events.some((event) => event.data?.preparationResume === true), false);

  await h.core.resume(value.id);
  await h.core.idle(value.id);
  const resumed = h.snapshot();
  assert.equal(resumed.run?.status, "paused");
  assert.deepEqual(h.calls, ["generate", "generate", "generate", "generate"]);
  assert.equal(h.modelCalls(), 6);
  assert.equal(resumed.events.filter((event) => event.data?.preparationResume === true).length, 1);
  assert.equal(resumed.pendingInput, undefined);
  assert.equal(resumed.pendingApproval, undefined);
  assert.equal(resumed.events.some((event) => event.data?.remoteWrite === true), false);
});

test("继续执行不把审批、待输入、不确定或远端写入运行当作本地准备重试", async () => {
  for (const kind of ["ordinary", "pendingInput", "pendingApproval", "uncertain", "approved", "remote"] as const) {
    const value = product();
    const h = harness(value);
    const snapshot = pausedSnapshot(value, kind !== "ordinary");
    if (kind === "pendingInput") snapshot.pendingInput = { id: "input", questions: [], createdAt: "t" };
    if (kind === "pendingApproval") snapshot.pendingApproval = {
      id: "approval", productVersion: "v1", accountKey: "local", scope: ["vbk.write_phase:basic"], summary: "录入", status: "pending", createdAt: "t",
    };
    if (kind === "uncertain") snapshot.uncertainWrite = { toolCallId: "write", message: "等待核对", createdAt: "t" };
    if (kind === "approved") snapshot.events.push({ id: "approval", runId: "run", type: "approval", content: "已授权", createdAt: "t", data: {
      approval: { id: "approval", productVersion: "v1", accountKey: "local", scope: ["vbk.write_phase:basic"], summary: "录入", status: "approved", createdAt: "t", intentVersion: "v:run" },
    } });
    if (kind === "remote") snapshot.events.push({ id: "remote", runId: "run", type: "tool_result", content: "已写入", createdAt: "t", data: { toolCallId: "write", remoteWrite: true } });
    h.replace(snapshot);
    await h.core.resume(value.id);
    await h.core.idle(value.id);
    assert.equal(h.snapshot().events.some((event) => event.data?.preparationResume === true), false, kind);
  }
});
