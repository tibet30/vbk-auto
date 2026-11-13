import assert from "node:assert/strict";
import test from "node:test";
import { ProductMutationService } from "../../src/main/application/product-mutation-service.js";
import { buildProductSnapshot } from "../../src/main/infrastructure/database/parts/product-draft.js";
import { applyManualReviewField } from "../../src/main/operations/manual-review-field.js";

/** 复刻真实事故：运营把查不到 POI 的景点手动改成「其他」，随后「继续执行」重新生成行程。 */
function setup() {
  let saved = buildProductSnapshot({ destination: "西宁", days: 1, productForm: "privateTour" });
  saved.product.itinerary = [{
    day: 1, title: "巴尔斯雪山", description: "巴尔斯雪山，张掖结束行程。", hotel: "无", meals: "自理",
    spots: [{ name: "巴尔斯雪山", kind: "attraction", poiName: null, poiId: null, timeOfDay: "morning", relation: "and" }],
  }];
  saved.product = applyManualReviewField(saved.product, {
    field: "itinerarySpotKind", dayIndex: 0, spotIndex: 0, kind: "other",
  }) as typeof saved.product;
  const service = new ProductMutationService({
    getProduct: () => saved,
    updateProduct: (_id, next, status) => { saved = { ...saved, product: next as typeof saved.product, status: status ?? saved.status }; },
  });
  return { service, saved: () => saved };
}

/** 生成/重跑路径写入的行程：只认识景点，POI 为空。 */
function regeneratedItinerary(poi?: { poiId: number; poiName: string }) {
  return [{
    day: 1, title: "巴尔斯雪山", description: "巴尔斯雪山，张掖结束行程。", hotel: "无", meals: "自理",
    spots: [{ name: "巴尔斯雪山", kind: "attraction", poiName: poi?.poiName ?? null,
      poiId: poi?.poiId ?? null, timeOfDay: "morning", relation: "and" }],
  }];
}

test("继续执行重新生成时不再把人工设置的「其他」改回景点", () => {
  const { service, saved } = setup();
  const result = service.applyAiPatch(saved().id, [{ op: "replace", path: "/itinerary", value: regeneratedItinerary() }]);
  assert.equal(result.applied, true);
  const spot = saved().product.itinerary![0]!.spots![0]!;
  assert.equal(spot.kind, "other");
  const records = (saved().product.manualReview as { itinerarySpotKinds?: Array<{ kind: string }> }).itinerarySpotKinds ?? [];
  assert.equal(records.length, 1);
});

test("人工改回景点后，后续生成写入保持景点", () => {
  const { service, saved } = setup();
  const restored = applyManualReviewField(saved().product, {
    field: "itinerarySpotKind", dayIndex: 0, spotIndex: 0, kind: "attraction",
  });
  service.replace(saved().id, restored, { source: "user" });
  service.applyAiPatch(saved().id, [{ op: "replace", path: "/itinerary", value: regeneratedItinerary() }]);
  assert.equal(saved().product.itinerary![0]!.spots![0]!.kind, "attraction");
});

test("资源核验写入的完整 POI 不被人工历史分类清空", () => {
  const { service, saved } = setup();
  service.replace(saved().id, {
    ...saved().product, itinerary: regeneratedItinerary({ poiId: 79459703, poiName: "巴尔斯雪山" }),
  }, { source: "resource", preserveVerifiedItineraryPois: false });
  const spot = saved().product.itinerary![0]!.spots![0]!;
  assert.equal(spot.poiId, 79459703);
  assert.equal(spot.poiName, "巴尔斯雪山");
});
