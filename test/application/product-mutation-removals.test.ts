import assert from "node:assert/strict";
import test from "node:test";
import { ProductMutationService } from "../../src/main/application/product-mutation-service.js";
import { buildProductSnapshot } from "../../src/main/infrastructure/database/parts/product-draft.js";
import { applyItinerarySpotRemove } from "../../src/main/operations/manual-review-itinerary-field.js";
import { alternativeGroupKey } from "../../src/shared/trusted-operator-itinerary-removals.js";
import { preserveItineraryRemovals } from "../../src/shared/preserve-itinerary-removals.js";

const museum = "汉中市古汉台博物馆";
function setup() {
  let saved = buildProductSnapshot({ destination: "西安", days: 6, productForm: "privateTour" });
  saved.product.itinerary = [{ day: 5, title: "佛坪到汉中", description: "游览佛坪熊猫谷。午后抵达汉中市区，参观古汉台博物馆了解两汉历史。傍晚入住酒店。",
    hotel: "汉中酒店", spots: [{ name: "佛坪熊猫谷", poiName: "佛坪熊猫谷旅游区", poiId: 22883772, kind: "attraction" },
      { name: museum, poiName: null, poiId: null, kind: "attraction" }] }];
  const stale = structuredClone(saved.product);
  saved.product = applyItinerarySpotRemove(saved.product, { field: "itinerarySpotRemove", dayIndex: 0, spotIndex: 1 }) as typeof saved.product;
  const service = new ProductMutationService({ getProduct: () => saved,
    updateProduct: (_id, next, status) => { saved = { ...saved, product: next as typeof saved.product, status: status ?? saved.status }; } });
  return { stale, service, saved: () => saved };
}

test("删除景点同时清理简称文案，保留同日其他安排", () => {
  const { saved } = setup();
  const day = saved().product.itinerary![0]!;
  assert.deepEqual(day.spots.map((spot) => spot.name), ["佛坪熊猫谷"]);
  assert.equal(day.description, "游览佛坪熊猫谷。午后抵达汉中市区，傍晚入住酒店。");
});

test("AI 修改酒店时重放旧行程，删除凭证优先于旧 spots 和旧文案", () => {
  const { stale, service, saved } = setup();
  stale.itinerary![0]!.hotel = "汉中4钻酒店";
  stale.itinerary![0]!.spots[0]!.poiId = null;
  stale.itinerary![0]!.spots[0]!.poiName = null;
  const result = service.applyAiPatch(saved().id, [{ op: "replace", path: "/itinerary", value: stale.itinerary }]);
  assert.equal(result.applied, true);
  const day = saved().product.itinerary![0]!;
  assert.deepEqual(day.spots.map((spot) => spot.name), ["佛坪熊猫谷"]);
  assert.equal(day.spots[0]!.poiId, 22883772);
  assert.equal(day.hotel, "汉中4钻酒店");
  assert.doesNotMatch(day.description!, /古汉台博物馆/);
  assert.equal((saved().product.manualReview as { itinerarySpotRemovals: unknown[] }).itinerarySpotRemovals.length, 1);
});

test("异步资源整包保存不能用删除之前的快照覆盖删除凭证", () => {
  const { stale, service, saved } = setup();
  service.replace(saved().id, stale);
  assert.deepEqual(saved().product.itinerary![0]!.spots.map((spot) => spot.name), ["佛坪熊猫谷"]);
  assert.equal((saved().product.manualReview as { itinerarySpotRemovals: unknown[] }).itinerarySpotRemovals.length, 1);
});

test("统一保存入口把接送地点迁出站点，重复 AI 整包覆盖不会重建后勤站点", () => {
  const { stale, service, saved } = setup();
  stale.itinerary = [{ day: 6, title: "汉中送站", description: "酒店出发送至汉中站", hotel: "无当日住宿安排",
    spots: [{ name: "汉中站", kind: "other", poiId: null, poiName: null }] }];
  service.replace(saved().id, stale);
  service.replace(saved().id, stale);
  assert.deepEqual(saved().product.itinerary![0]!.spots, []);
  assert.equal(saved().product.itinerary![0]!.activities?.length, 1);
  assert.equal(saved().product.itinerary![0]!.activities?.[0]!.type, "transport");
});

test("明确人工加回可撤销凭证，后续自动保存保留新决定", () => {
  const { stale, service, saved } = setup();
  const oldReceipt = structuredClone(saved().product.manualReview);
  stale.manualReview = { itinerarySpotRemovals: [] };
  service.replace(saved().id, stale, { allowItineraryRemovalRestore: true });
  const oldSnapshot = structuredClone(saved().product);
  oldSnapshot.manualReview = oldReceipt;
  service.replace(saved().id, oldSnapshot);
  assert.ok(saved().product.itinerary![0]!.spots.some((spot) => spot.name === museum));
  assert.deepEqual((saved().product.manualReview as { itinerarySpotRemovals: unknown[] }).itinerarySpotRemovals, []);
});

test("删除凭证只作用于指定日期和OR组，同名另一组及另一日保留", () => {
  const product = {
    manualReview: { itinerarySpotRemovals: [{ day: 1, name: "乙", removedAt: "now", groupKey: alternativeGroupKey(1, ["甲", "乙"]) }] },
    itinerary: [
      { day: 1, spots: [
        { name: "甲", relation: "or", timeOfDay: "morning" }, { name: "乙", relation: "or", timeOfDay: "morning" },
        { name: "丙", relation: "or", timeOfDay: "afternoon" }, { name: "乙", relation: "or", timeOfDay: "afternoon" },
      ] },
      { day: 2, spots: [{ name: "乙", relation: "and" }] },
    ],
  };
  const result = preserveItineraryRemovals(product, product);
  const itinerary = result.itinerary as typeof product.itinerary;
  assert.deepEqual(itinerary[0]!.spots.map((spot) => spot.name), ["甲", "丙", "乙"]);
  assert.equal(itinerary[0]!.spots[0]!.relation, "and");
  assert.equal(itinerary[0]!.spots[2]!.relation, "or");
  assert.equal(itinerary[1]!.spots[0]!.name, "乙");
  assert.equal(product.itinerary[0]!.spots.length, 4);
});
