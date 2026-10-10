import test from "node:test";
import assert from "node:assert/strict";
import { replacementDraftProductId } from "../../src/shared/product-replacement.js";
import { preflightRepairPhase } from "../../src/main/automation/automation.main/preflight-repair-phase.js";
import { hotelDowngradePermission } from "../../src/shared/hotel-downgrade-policy.js";
import { hasVerifiedRouteAdministrativeNode } from "../../src/shared/route-administrative-nodes.js";
import { incompleteTrafficVariants } from "../../src/shared/traffic-resource-status.js";

test("replacementDraftProductId only accepts the persisted takeover prefix and numeric id", () => {
  assert.equal(replacementDraftProductId({ workflowTask: { message: "已由新草稿 79411226 接管；旧任务已收敛" } } as any), "79411226");
  assert.equal(replacementDraftProductId({ workflowTask: { message: "建议由新草稿 79411226 接管；待确认" } } as any), undefined);
});

test("preflightRepairPhase does not reopen modules for imprecise hotel text", () => {
  assert.equal(preflightRepairPhase("酒店资源回读失败，请重试"), undefined);
  assert.equal(preflightRepairPhase("酒店资源只读回读住宿段数量不一致：期望 2，实际 0"), "hotelResource");
});

test("hotelDowngradePermission lets the latest explicit global decision win", () => {
  assert.equal(hotelDowngradePermission("可以降低钻级；后来决定不要降档"), false);
});

test("hasVerifiedRouteAdministrativeNode matches normalized administrative short names only", () => {
  const product = { diagnostics: { routeAdministrativeNodes: [{ day: 2, name: "成都市", districtId: 510100 }] } };
  assert.equal(hasVerifiedRouteAdministrativeNode(product, "成都", 2), true);
  assert.equal(hasVerifiedRouteAdministrativeNode(product, "成都", 1), false);
});

test("incompleteTrafficVariants keeps enabled missing variants but excludes durable unavailable failures", () => {
  const config = { enabled: true, variants: ["flightRoundTrip", "trainRoundTrip"] } as const;
  const progress = { children: [{ variant: "trainRoundTrip", verified: false, completedStages: [], failureReason: "当前无可售资源" }] } as any;
  assert.deepEqual(incompleteTrafficVariants(config as any, progress), ["flightRoundTrip"]);
});
