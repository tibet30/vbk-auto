import test from "node:test";
import assert from "node:assert/strict";
import type { ProductDetail } from "../../src/shared/contracts.js";
import { historicalConfirmedPoiId } from "../../src/main/planning/historical-poi-selection.js";
import { resolvePlanningPoiAutoSelection } from "../../src/main/planning/poi-auto-selection.js";

const product = (id: string) => ({ id, vbkAccount: "account", productId: "123", automation: { status: "succeeded" }, product: {
  basicInfo: { userIdea: "D1 城区老街", province: "四川", meetingCity: "成都" }, itinerary: [{ day: 1, spots: [{ name: "城区老街", poiName: "古街", poiId: 123 }] }],
} }) as unknown as ProductDetail;
const human = { type: "user", data: { requestId: "request", resolvedAnswers: { poi: "古街（poiId 123）" } } };
function database(previous = product("old"), events: unknown[] = [human]) {
  return { listProducts: () => [{ id: "old" }], getProduct: () => previous, getAgentSnapshot: () => ({ events }) } as any;
}
test("已完成的相同行程仅复用真实用户确认，不同账号/路线/失败产品不复用", () => {
  const current = product("new");
  assert.equal(historicalConfirmedPoiId(database(), current, "城区老街"), 123);
  assert.equal(historicalConfirmedPoiId(database(product("old"), [{ ...human, type: "assistant" }]), current, "城区老街"), undefined);
  for (const change of [{ vbkAccount: "other" }, { automation: { status: "failed" } }, { product: { ...product("old").product, basicInfo: { userIdea: "D1 其他路线" } } }]) {
    assert.equal(historicalConfirmedPoiId(database({ ...product("old"), ...change } as ProductDetail), current, "城区老街"), undefined);
  }
});
test("历史确认仍核查线上候选、地理位置与营业状态", async () => {
  let checks = 0;
  const args = { localProductId: "new", keyword: "城区老街", product: {}, context: { province: "四川", destinationCity: "成都" }, confirmedPoiId: 123,
    detail: { candidates: [{ index: 1, selectable: true, poiId: 123, poiName: "古街", city: "成都", province: "四川" }], best: null },
    checkAvailability: async () => { checks++; return { status: "available" as const }; },
  };
  assert.equal((await resolvePlanningPoiAutoSelection(args as any)).match?.poiId, 123);
  assert.equal(checks, 1);
  assert.equal((await resolvePlanningPoiAutoSelection({ ...args, detail: { candidates: [], best: null } } as any)).match, undefined);
  assert.equal((await resolvePlanningPoiAutoSelection({ ...args, context: { province: "浙江" } } as any)).match, undefined);
  assert.equal((await resolvePlanningPoiAutoSelection({ ...args, checkAvailability: async () => ({ status: "suspended" }) } as any)).status, "suspended");
});
