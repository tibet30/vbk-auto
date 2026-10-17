import assert from "node:assert/strict";
import test from "node:test";
import { AgentCore } from "../../src/main/agent/core.js";
import { agentProductVersion, approvalForRun, buildAgentApproval, requiredAgentPhases } from "../../src/main/agent/integration-gates.js";
import { agentApprovalScopeError, normalizeAgentApprovalScope } from "../../src/main/agent/integration-guard.js";
import { buildProductSnapshot } from "../../src/main/infrastructure/database/parts/product-draft.js";
import { ITINERARY_REVIEW_UNLOCK_SCOPE, itineraryReviewUnlockAuthorized } from "../../src/shared/itinerary-review-approval.js";
import type { AgentApproval, AgentSnapshot } from "../../src/shared/contracts.js";

function fixture(includeReview = true) {
  const product = buildProductSnapshot({ destination: "成都", days: 2, productForm: "privateTour" });
  const proposal = buildAgentApproval(product);
  const approval: AgentApproval = {
    id: "approval", createdAt: "now", status: "pending", summary: proposal.summary,
    accountKey: "account", productVersion: agentProductVersion(product), intentVersion: "intent",
    scope: includeReview ? proposal.scope : requiredAgentPhases(product).map(phase => `vbk.write_phase:${phase}`),
  };
  let saved: AgentSnapshot = { localProductId: product.id,
    run: { id: "run", status: "waiting_approval", intentVersion: "intent", createdAt: "now", updatedAt: "now" },
    events: [], pendingApproval: approval };
  let handoffs = 0;
  const core = new AgentCore({ tools: [],
    accountFor: async () => ({ accountKey: "account", productVersion: agentProductVersion(product) }),
    handoffApprovedWorkflow: () => { handoffs++; return true; },
  }, {
    getAgentSnapshot: () => structuredClone(saved),
    saveAgentSnapshot: value => { saved = structuredClone(value); },
  });
  return { product, approval, core, read: () => saved, handoffs: () => handoffs };
}

test("一次普通录入确认包含自动行程审核，不增加交通或发布权限", async () => {
  const f = fixture();
  assert.ok(f.approval.scope.includes(ITINERARY_REVIEW_UNLOCK_SCOPE));
  assert.match(f.approval.summary, /自动提交母产品行程审核并解锁全部标签，不发布/);
  await f.core.approve(f.product.id, { approvalId: f.approval.id, productVersion: f.approval.productVersion });
  const approved = approvalForRun(f.read())!;
  assert.equal(approved.itineraryReviewUnlockAuthorized, true);
  assert.equal(itineraryReviewUnlockAuthorized(f.read()), true);
  assert.equal(approved.generateTrafficChildren, false);
  assert.equal(approved.trafficRouteReviewAuthorized, false);
  assert.equal(f.handoffs(), 1);
  assert.equal(f.read().pendingApproval, undefined);
});

test("旧草稿确认和明确排除审核的响应不授予自动解锁", async () => {
  for (const excluded of [false, true]) {
    const f = fixture(excluded);
    await f.core.approve(f.product.id, { approvalId: f.approval.id, productVersion: f.approval.productVersion,
      ...(excluded ? { itineraryReviewUnlockAuthorized: false } : {}) });
    assert.equal(itineraryReviewUnlockAuthorized(f.read()), false);
    assert.equal(approvalForRun(f.read())!.itineraryReviewUnlockAuthorized, false);
  }
});

test("只为新的完整录入范围补充自动审核，窄范围和旧批准不被扩大", () => {
  const f = fixture();
  const phases = requiredAgentPhases(f.product).map(phase => `vbk.write_phase:${phase}`);
  const normalized = normalizeAgentApprovalScope(f.product, phases);
  assert.ok(normalized.includes(ITINERARY_REVIEW_UNLOCK_SCOPE));
  assert.equal(agentApprovalScopeError(f.product, normalized), undefined);
  assert.deepEqual(normalizeAgentApprovalScope(f.product, ["basic"]), ["vbk.write_phase:basic"]);
  assert.equal(phases.includes(ITINERARY_REVIEW_UNLOCK_SCOPE), false);
});

test("已有产品的重审批会收窄遗留 saleControl，不制造额外继续门槛", () => {
  const f = fixture();
  f.product.productId = "79924183";
  const required = requiredAgentPhases(f.product).map(phase => `vbk.write_phase:${phase}`);
  const normalized = normalizeAgentApprovalScope(f.product, [...required, "vbk.write_phase:saleControl"]);
  assert.deepEqual(normalized.filter(item => item.startsWith("vbk.write_phase:")), required);
  assert.equal(agentApprovalScopeError(f.product, normalized), undefined);
});
