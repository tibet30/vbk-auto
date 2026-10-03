import assert from "node:assert/strict";
import test from "node:test";
import { ensureTrafficLinePhase } from "../../src/main/automation/ctrip/traffic-line/run-phase.js";

test("已确认机场端点仍以平台当前班期无可售资源结果为准，保留未验证子产品并允许母产品预检", async () => {
  const checkpoints: any[] = [];
  const result = await ensureTrafficLinePhase({
    page: {
      vbkSessionGetText: async () => ({ status: 200, text: '<script>window.__INITIAL_STATE__ = {"childList":[]};</script>' }),
      evaluate: async () => { throw new Error("VBK 校验后没有任何可用的多出发城市，子产品未激活。"); },
    },
    parentProductId: "79236447",
    config: {
      enabled: true,
      variants: ["flightRoundTrip"],
      availability: {
        endpointPlan: {
          arrivalCity: "日喀则", departureCity: "日喀则", resolvedAt: "2026-10-03T00:00:00.000Z",
          flight: { arrival: { code: "RKZ", name: "和平机场" }, departure: { code: "RKZ", name: "和平机场" } },
        },
        availableVariants: ["flightRoundTrip"], unavailableVariants: {},
      },
    },
    itinerary: [{ spots: [{ city: "日喀则" }] }],
    log: () => {}, onCheckpoint: (checkpoint) => checkpoints.push(checkpoint),
  });
  assert.equal(result.blocked, 1);
  assert.deepEqual(result.children, []);
  assert.equal(checkpoints.at(-1).verifiedAt, undefined);
  assert.match(checkpoints.at(-1).failureReason, /没有任何可用的多出发城市/);
  assert.equal(checkpoints.at(-1).children[0].verified, false);
});
