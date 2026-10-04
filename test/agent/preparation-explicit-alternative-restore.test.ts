import assert from "node:assert/strict";
import test from "node:test";
import { restoreExplicitAlternativeSlots, restoreExplicitOperatorDeletion } from "../../src/main/agent/integration-setup.js";
import { buildProductSnapshot } from "../../src/main/infrastructure/database/parts/product-draft.js";
import { applyManualReviewField } from "../../src/main/operations/manual-review-field.js";
import { alternativeGroupKey } from "../../src/shared/trusted-operator-itinerary-removals.js";

function actualProduct() {
  const detail = buildProductSnapshot({ destination: "日喀则", days: 3, productForm: "privateTour" });
  detail.productId = "79255068";
  Object.assign(detail.product.basicInfo!, {
    days: 3, nights: 2, meetingCity: "日喀则", destinationCity: "日喀则", province: "西藏",
    subtitle: "日喀则三日私家团", operationNotes: "按运营原行程", userIdea: "第一天：萨迦古城。\n第二天：羊卓雍湖。\n第三天：日喀则博物馆或非遗中心参观 → 扎什伦布寺参观 → 送火车。",
  });
  detail.product.itinerary = [
    { day: 1, title: "萨迦古城", description: "游览", meals: "自理", hotel: "日喀则酒店", spots: [{ name: "萨迦古城", poiName: "萨迦古城", poiId: 1 }] },
    { day: 2, title: "羊卓雍湖", description: "游览", meals: "自理", hotel: "日喀则酒店", spots: [{ name: "羊卓雍湖", poiName: "羊卓雍湖", poiId: 2 }] },
    { day: 3, title: "博物馆与扎什伦布寺", description: "送站", meals: "自理", hotel: "无", spots: [
      { name: "非遗中心参观", kind: "attraction", poiName: "非遗中心", poiId: 5, relation: "and", timeOfDay: "morning" },
      { name: "扎什伦布寺参观", kind: "attraction", poiName: "扎什伦布寺", poiId: 4, relation: "and", timeOfDay: "afternoon" },
      { name: "送火车", kind: "other" },
    ] },
  ] as never;
  detail.planning = {
    userIntent: {
      rawIdea: "第三天：日喀则博物馆或非遗中心参观 → 扎什伦布寺参观 → 送火车。",
      preferences: [],
      activities: [{ id: "d3-humanities", day: 3, title: "日喀则博物馆", kind: "poi", alternatives: ["非遗中心参观"] }],
    },
  } as never;
  return detail;
}

test("已有平台 ID 的明确本地恢复仍补回缺失 OR 槽位，不触碰远端", () => {
  const detail = actualProduct();
  const restored = restoreExplicitAlternativeSlots(detail, "恢复第3天非遗中心参观，并按原顺序继续本地规划");
  assert.ok(restored);
  const day = (restored!.itinerary as Array<Record<string, unknown>>)[2]!;
  assert.deepEqual((day.spots as Array<Record<string, unknown>>).map((spot) => [spot.name, spot.relation, spot.poiId]), [
    ["日喀则博物馆", "or", null], ["非遗中心参观", "or", 5], ["扎什伦布寺参观", "and", 4], ["送火车", undefined, undefined],
  ]);
  assert.equal(detail.productId, "79255068");
});

test("可信人工删除凭证仍阻止本地恢复", () => {
  const detail = actualProduct();
  detail.product.manualReview = { itinerarySpotRemovals: [{ day: 3, name: "日喀则博物馆", removedAt: "2026-10-04T00:00:00.000Z" }] };
  assert.equal(restoreExplicitAlternativeSlots(detail, "恢复第3天日喀则博物馆"), undefined);
});

test("明确恢复精确日次景点会撤销删除凭证，再重新锁住该槽位", () => {
  const detail = actualProduct();
  detail.product.manualReview = { itinerarySpotRemovals: [
    { day: 3, name: "非遗中心参观", removedAt: "2026-10-04T00:00:00.000Z" },
    { day: 3, name: "另一景点", removedAt: "2026-10-04T00:00:00.000Z" },
  ] };
  assert.equal(restoreExplicitOperatorDeletion(detail.product, "恢复D3非遗中心参观和另一景点"), true);
  assert.deepEqual((detail.product.manualReview as Record<string, unknown>).itinerarySpotRemovals, []);
  const restored = restoreExplicitAlternativeSlots(detail, "恢复第3天非遗中心参观");
  assert.ok(restored);
  assert.equal((restored!.itinerary as Array<Record<string, unknown>>)[2]!.spots instanceof Array, true);
});

test("手动删除生成 groupKey 后，明确恢复会撤销收据并恢复原槽位", () => {
  const detail = actualProduct();
  const full = restoreExplicitAlternativeSlots(detail, "恢复第3天非遗中心参观");
  assert.ok(full); detail.product = { ...detail.product, itinerary: full!.itinerary };
  const deleted = applyManualReviewField(detail.product as Record<string, unknown>, { field: "itinerarySpotRemove", dayIndex: 2, spotIndex: 1 });
  detail.product = deleted as never;
  const receipt = ((deleted.manualReview as Record<string, unknown>).itinerarySpotRemovals as Array<Record<string, unknown>>)[0]!;
  assert.equal(receipt.groupKey, alternativeGroupKey(3, ["日喀则博物馆", "非遗中心参观"]));
  assert.equal(restoreExplicitOperatorDeletion(detail.product, "恢复D3非遗中心参观"), true);
  assert.deepEqual((detail.product.manualReview as Record<string, unknown>).itinerarySpotRemovals, []);
  const restored = restoreExplicitAlternativeSlots(detail, "恢复D3非遗中心参观");
  assert.ok(restored);
  assert.deepEqual((restored!.itinerary as Array<Record<string, unknown>>)[2]!.spots!.map((spot) => spot.name).slice(0, 2), ["日喀则博物馆", "非遗中心参观"]);
});

test("同日同名跨 OR 组时，只能按指明的组同伴撤销收据", () => {
  const product: Record<string, unknown> = { manualReview: { itinerarySpotRemovals: [
    { day: 1, name: "X", removedAt: "now", groupKey: alternativeGroupKey(1, ["甲", "X"]) },
    { day: 1, name: "X", removedAt: "now", groupKey: alternativeGroupKey(1, ["乙", "X"]) },
  ] } };
  assert.equal(restoreExplicitOperatorDeletion(product, "恢复D1 X"), false);
  assert.equal(restoreExplicitOperatorDeletion(product, "恢复D1 甲和X"), true);
  assert.deepEqual((product.manualReview as Record<string, unknown>).itinerarySpotRemovals, [{
    day: 1, name: "X", removedAt: "now", groupKey: alternativeGroupKey(1, ["乙", "X"]),
  }]);
});
