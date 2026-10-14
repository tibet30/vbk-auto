import assert from "node:assert/strict";
import test from "node:test";
import { AgentCore } from "../../src/main/agent/core.js";
import { agentProductVersion, agentCompletionGate, approvalForRun, requiredAgentPhases } from "../../src/main/agent/integration-gates.js";
import { assertAgentWriteAuthorized } from "../../src/main/agent/integration-guard.js";
import { buildProductSnapshot } from "../../src/main/infrastructure/database/parts/product-draft.js";
import { approvedWorkflowPlan } from "../../src/main/automation/automation.main/runtime/workflow-plan.js";
import type { AgentApproval, AgentSnapshot, ProductReadiness } from "../../src/shared/contracts.js";

function fixture() {
  const product = buildProductSnapshot({ destination: "成都", days: 2, productForm: "privateTour" });
  Object.assign(product.product.basicInfo!, { subtitle: "成都旅行", province: "四川", operationNotes: "按行程安排" });
  Object.assign(product.product.operations!, { pickupCity: "成都", trafficLine: { enabled: true, variants: ["trainRoundTrip"] } });
  product.product.itinerary = [1, 2].map(day => ({ day, title: "成都", spots: [], description: "游览成都", hotel: "", meals: "自理" }));
  product.productId = "parent"; product.status = "draft_saved";
  product.automation = { id: "automation", status: "succeeded", logs: [],
    phases: requiredAgentPhases(product).filter(phase => phase !== "trafficLine").map(phase => ({ phase, status: "completed" })) };
  const approval: AgentApproval = { id: "approval", createdAt: "now", status: "pending", summary: "录入",
    accountKey: "account", productVersion: agentProductVersion(product), intentVersion: "intent",
    scope: requiredAgentPhases(product).map(phase => `vbk.write_phase:${phase}`) };
  let saved: AgentSnapshot = { localProductId: product.id, run: { id: "run", status: "waiting_approval", intentVersion: "intent", createdAt: "now", updatedAt: "now" }, events: [], pendingApproval: approval };
  let handoffs = 0;
  let account = "account";
  let blocker: string | undefined;
  const core = new AgentCore({ tools: [], preparationProduct: () => product,
    accountFor: async () => ({ accountKey: account, productVersion: agentProductVersion(product) }),
    productFingerprint: async () => agentProductVersion(product),
    approvalPrecondition: async () => blocker,
    handoffApprovedWorkflow: () => { handoffs++; return true; } }, {
    getAgentSnapshot: () => structuredClone(saved), saveAgentSnapshot: value => { saved = structuredClone(value); },
  });
  return { core, product, approval, read: () => saved, handoffs: () => handoffs,
    status: (status: NonNullable<AgentSnapshot["run"]>["status"]) => { saved.run!.status = status; saved.pendingApproval = undefined; },
    account: (value: string) => { account = value; }, blocker: (value: string) => { blocker = value; } };
}

test("默认授权不生成子产品：拒绝交通写入，母产品可独立完成且不会自动补录", async () => {
  const f = fixture();
  await f.core.approve(f.product.id, { approvalId: f.approval.id, productVersion: f.approval.productVersion, trafficRouteReviewAuthorized: true });
  const approval = approvalForRun(f.read())!;
  assert.equal(approval.generateTrafficChildren, false);
  assert.equal(approval.trafficRouteReviewAuthorized, false);
  assert.throws(() => assertAgentWriteAuthorized(f.product, f.read(), "trafficLine", "account"), /未授权生成子产品/);
  assert.deepEqual(approvedWorkflowPlan(f.product, undefined, false), { kind: "complete" });
  assert.equal(agentCompletionGate(f.product, f.read(), { ready: true } as ProductReadiness,
    { runId: "run", hadWrites: true, hadRemoteWrites: true, deterministicWorkflow: true }).verified, true);
});

test("缺少子产品选择的旧授权不会自动补录或授予交通写入", async () => {
  const f = fixture();
  await f.core.approve(f.product.id, { approvalId: f.approval.id, productVersion: f.approval.productVersion });
  const snapshot = f.read();
  delete approvalForRun(snapshot)!.generateTrafficChildren;
  assert.deepEqual(approvedWorkflowPlan(f.product), { kind: "complete" });
  assert.throws(() => assertAgentWriteAuthorized(f.product, snapshot, "trafficLine", "account"), /未授权生成子产品/);
  assert.equal(agentCompletionGate(f.product, snapshot, { ready: true } as ProductReadiness,
    { runId: "run", hadWrites: true, hadRemoteWrites: true, deterministicWorkflow: true }).verified, true);
});

test("勾选生成子产品才授予交通写入权限", async () => {
  const f = fixture();
  await f.core.approve(f.product.id, { approvalId: f.approval.id, productVersion: f.approval.productVersion, generateTrafficChildren: true });
  assert.equal(approvalForRun(f.read())!.generateTrafficChildren, true);
  assert.doesNotThrow(() => assertAgentWriteAuthorized(f.product, f.read(), "trafficLine", "account"));
  assert.deepEqual(approvedWorkflowPlan(f.product, undefined, true), { kind: "traffic-backfill" });
});

test("稍后手动录入生成新授权并保留编号与进度，只允许子产品和回读", async () => {
  const f = fixture(); f.status("completed");
  f.product.automation!.trafficLine = { children: [{ variant: "trainRoundTrip", lineDescription: "火车往返", childProductId: "child", completedStages: ["childCreated"], verified: false }] };
  const before = structuredClone(f.product);
  await f.core.createTrafficChildren(f.product.id, false);
  const approval = approvalForRun(f.read())!;
  assert.notEqual(approval.id, f.approval.id);
  assert.equal(approval.generateTrafficChildren, true);
  assert.equal(approval.trafficChildrenOnly, true);
  assert.equal(approval.trafficRouteReviewAuthorized, false);
  assert.equal(f.handoffs(), 1);
  assert.deepEqual(f.product, before);
  assert.doesNotThrow(() => assertAgentWriteAuthorized(f.product, f.read(), "trafficLine", "account"));
  assert.doesNotThrow(() => assertAgentWriteAuthorized(f.product, f.read(), "preflight", "account"));
  assert.throws(() => assertAgentWriteAuthorized(f.product, f.read(), "basic", "account"), /仅授权子产品/);
  await assert.rejects(f.core.createTrafficChildren(f.product.id, false), /当前任务/);
});

test("手动录入拒绝未完成母产品、变更账号和准备门禁阻塞", async () => {
  for (const reason of ["parent", "account", "readiness"] as const) {
    const f = fixture(); f.status("completed");
    if (reason === "parent") f.product.automation!.phases.find(p => p.phase === "preflight")!.status = "pending";
    if (reason === "account") { f.product.vbkAccount = "account"; f.account("other"); }
    if (reason === "readiness") f.blocker("资源门禁阻塞");
    await assert.rejects(f.core.createTrafficChildren(f.product.id, true), /母产品|账号|门禁/);
    assert.equal(f.handoffs(), 0);
    assert.equal(f.read().events.some(e => e.type === "approval"), false);
  }
});
