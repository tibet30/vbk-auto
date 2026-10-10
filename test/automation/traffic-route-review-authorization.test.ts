import test from "node:test";
import assert from "node:assert/strict";
import { AgentCore } from "../../src/main/agent/core.js";
import { trafficRouteReviewAuthorized } from "../../src/shared/traffic-route-review-approval.js";
import { ensureAuthorizedTrafficRouteReview } from "../../src/main/automation/ctrip/traffic-line/authorized-route-review.js";
import type { AgentApproval, AgentSnapshot } from "../../src/shared/contracts-agent.js";

const approval: AgentApproval = { id: "approval", accountKey: "a", productVersion: "version", scope: ["vbk.write_phase:trafficLine"],
  summary: "录入交通套餐", status: "approved", createdAt: "now", intentVersion: "intent", trafficRouteReviewAuthorized: true };
function snapshot(value = approval): AgentSnapshot {
  return { localProductId: "p", run: { id: "run", status: "running", createdAt: "now", updatedAt: "now", intentVersion: "intent" },
    events: [{ id: "e", runId: "run", type: "approval", content: "用户确认", createdAt: "now", data: { approval: value } }] };
}

test("线路审核只接受当前意图最后一次明确用户授权", () => {
  assert.equal(trafficRouteReviewAuthorized(snapshot()), true);
  for (const patch of [{ trafficRouteReviewAuthorized: undefined }, { status: "pending" as const },
    { intentVersion: "old" }, { scope: ["vbk.write_phase:itinerary"] }]) {
    assert.equal(trafficRouteReviewAuthorized(snapshot({ ...approval, ...patch })), false);
  }
  const s = snapshot();
  s.events.push({ ...s.events[0], id: "later", data: { approval: { ...approval, trafficRouteReviewAuthorized: false } } });
  assert.equal(trafficRouteReviewAuthorized(s), false);
  assert.equal(trafficRouteReviewAuthorized(undefined), false);
});

test("最终确认从用户响应持久化独立审核授权，模型请求不能自行授予", async () => {
  for (const explicit of [true, false]) {
    let saved: AgentSnapshot = { ...snapshot(), events: [], pendingApproval: { ...approval, status: "pending" } };
    saved.run!.status = "waiting_approval";
    const core = new AgentCore({ tools: [], model: { complete: async () => ({ content: "unused" }) },
      accountFor: async () => ({ accountKey: "a", productVersion: "version" }), handoffApprovedWorkflow: () => true },
    { getAgentSnapshot: () => saved, saveAgentSnapshot: s => { saved = structuredClone(s); } });
    await core.approve("p", { approvalId: "approval", productVersion: "version", trafficRouteReviewAuthorized: explicit });
    assert.equal(trafficRouteReviewAuthorized(saved), explicit);
  }
});

test("未勾选独立审核授权时不发起任何线路审核调用", async () => {
  const page = { evaluate: async () => { throw new Error("不允许调用"); } } as any;
  await ensureAuthorizedTrafficRouteReview(page, "1", false, () => {});
});

test("授权后先审核母产品并独立确认结果，已通过的恢复不重复提交", async () => {
  let routeId = 0;
  let submits = 0;
  const tid = "419192863866962044";
  const page = { nativeOnly: true, evaluate: async () => { throw new Error("禁止旁路"); },
    vbkSessionFetch: async (request: any) => {
      const method = request.endpoint.split("/").pop();
      const relation = { productId: 1, tourInfoId: tid, main: true, auditStatus: { key: routeId ? "A" : "N" } };
      let fields: any;
      switch (method) {
        case "getProductBaseInfo": fields = { baseInfo: { routeId }, meta: { saveStep: -60 } }; break;
        case "getProductTourInfoList": fields = { tourInfos: [relation] }; break;
        case "getTourDailyDetail.json": fields = { tourInfo: { tourInfoId: tid, tourDailyDescriptions: [{ orderDay: 1, tourDailyInfos: [] }] } }; break;
        case "checkTourDaily": fields = { productTourInfo: relation, tourDaily: request.body.tourDaily }; break;
        case "saveTourDailyDetail.json": fields = { tourInfoId: tid }; break;
        case "saveProductTourInfo": submits++; routeId = 123456; fields = {}; break;
        default: throw new Error(`unexpected ${method}`);
      }
      return { status: 200, payload: { ResponseStatus: { Ack: "Success" }, ...fields }, context: {} };
    } } as any;
  await ensureAuthorizedTrafficRouteReview(page, "1", true, () => {});
  await ensureAuthorizedTrafficRouteReview(page, "1", true, () => {});
  assert.equal(submits, 1);
});
