import assert from "node:assert/strict";
import test from "node:test";
import { ProductMutationService } from "../../src/main/application/product-mutation-service.js";
import { buildProductSnapshot } from "../../src/main/infrastructure/database/parts/product-draft.js";
import { applyItinerarySpotRemove } from "../../src/main/operations/manual-review-itinerary-field.js";
import { alternativeGroupKey, clearReappearedTrustedOperatorItineraryRemovals } from "../../src/shared/trusted-operator-itinerary-removals.js";
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
  assert.equal(day.hotel, "使用携程平台酒店，自动匹配三钻、四钻、五钻酒店");
  assert.doesNotMatch(day.description!, /古汉台博物馆/);
  assert.equal((saved().product.manualReview as { itinerarySpotRemovals: unknown[] }).itinerarySpotRemovals.length, 1);
});

test("异步资源整包保存不能用删除之前的快照覆盖删除凭证", () => {
  const { stale, service, saved } = setup();
  service.replace(saved().id, stale);
  assert.deepEqual(saved().product.itinerary![0]!.spots.map((spot) => spot.name), ["佛坪熊猫谷"]);
  assert.equal((saved().product.manualReview as { itinerarySpotRemovals: unknown[] }).itinerarySpotRemovals.length, 1);
});

test("同一 POI 换展示名回填时仍受删除凭证拦截", () => {
  let saved = buildProductSnapshot({ destination: "拉萨", days: 1, productForm: "privateTour" });
  saved.product.itinerary = [{ day: 1, title: "冈仁波齐", description: "参观冈仁波齐。", spots: [
    { name: "冈仁波齐", poiName: "冈仁波齐", poiId: 10758151, kind: "attraction" },
  ] }];
  saved.product = applyItinerarySpotRemove(saved.product, {
    field: "itinerarySpotRemove", dayIndex: 0, spotIndex: 0,
  }) as typeof saved.product;
  const incoming = structuredClone(saved.product);
  incoming.itinerary![0]!.spots = [
    { name: "冈仁波齐山体冰川遗迹", poiName: "冈仁波齐", poiId: 10758151, kind: "attraction" },
  ];
  incoming.itinerary![0]!.description = "参观冈仁波齐山体冰川遗迹。";
  const service = new ProductMutationService({ getProduct: () => saved,
    updateProduct: (_id, next, status) => { saved = { ...saved, product: next as typeof saved.product, status: status ?? saved.status }; } });
  service.replace(saved.id, incoming);
  assert.deepEqual(saved.product.itinerary![0]!.spots, []);
  assert.doesNotMatch(saved.product.itinerary![0]!.description!, /冈仁波齐/);
  const receipt = (saved.product.manualReview as { itinerarySpotRemovals: Array<{ poiName?: string; poiId?: number }> })
    .itinerarySpotRemovals[0]!;
  assert.deepEqual({ poiName: receipt.poiName, poiId: receipt.poiId }, { poiName: "冈仁波齐", poiId: 10758151 });
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

const SPOT_A = "sp_aaaaaaaaaaaa";
const SPOT_B = "sp_bbbbbbbbbbbb";
const SPOT_C = "sp_cccccccccccc";
type Receipt = { spotId?: string; name: string; groupKey?: string };
const receiptsOf = (product: unknown) =>
  (product as { manualReview: { itinerarySpotRemovals: Receipt[] } }).manualReview.itinerarySpotRemovals;

test("删除凭证记录被删景点的 spotId", () => {
  const product = buildProductSnapshot({ destination: "潮州", days: 1, productForm: "privateTour" }).product;
  product.itinerary = [{ day: 1, title: "潮州", description: "游览", spots: [
    { spotId: SPOT_A, name: "广济桥", poiName: null, poiId: null, kind: "attraction" },
  ] }];
  const next = applyItinerarySpotRemove(product, { field: "itinerarySpotRemove", dayIndex: 0, spotIndex: 0 });
  assert.equal(receiptsOf(next)[0]!.spotId, SPOT_A);
});

test("删除带括号注释的景点后，模型以无注释名重新生成，仍被拦截", () => {
  let saved = buildProductSnapshot({ destination: "潮州", days: 1, productForm: "privateTour" });
  saved.product.itinerary = [{ day: 1, title: "潮州古城", description: "游览古城。", spots: [
    { name: "广济桥（不上桥）", poiName: null, poiId: null, kind: "attraction" },
    { name: "牌坊街", poiName: null, poiId: null, kind: "attraction" },
  ] }];
  saved.product = applyItinerarySpotRemove(saved.product, { field: "itinerarySpotRemove", dayIndex: 0, spotIndex: 0 }) as typeof saved.product;
  const incoming = structuredClone(saved.product);
  incoming.itinerary![0]!.spots = [
    { name: "广济桥", poiName: null, poiId: null, kind: "attraction" },
    { name: "牌坊街", poiName: null, poiId: null, kind: "attraction" },
  ];
  const service = new ProductMutationService({ getProduct: () => saved,
    updateProduct: (_id, next, status) => { saved = { ...saved, product: next as typeof saved.product, status: status ?? saved.status }; } });
  service.replace(saved.id, incoming);
  assert.deepEqual(saved.product.itinerary![0]!.spots.map((spot) => spot.name), ["牌坊街"]);
});

test("二选一删除一项后重新生成：被删项不复活，同组其余项保留", () => {
  let saved = buildProductSnapshot({ destination: "潮州", days: 1, productForm: "privateTour" });
  const option = (name: string) => ({ name, poiName: null, poiId: null, kind: "attraction" as const, relation: "or" as const, timeOfDay: "morning" as const });
  saved.product.itinerary = [{ day: 1, title: "潮州", description: "上午三选一。", spots: [option("甲景点"), option("乙景点"), option("丙景点")] }];
  saved.product = applyItinerarySpotRemove(saved.product, { field: "itinerarySpotRemove", dayIndex: 0, spotIndex: 1 }) as typeof saved.product;
  const incoming = structuredClone(saved.product);
  incoming.itinerary![0]!.spots = [option("甲景点"), option("乙景点"), option("丙景点")];
  const service = new ProductMutationService({ getProduct: () => saved,
    updateProduct: (_id, next, status) => { saved = { ...saved, product: next as typeof saved.product, status: status ?? saved.status }; } });
  service.replace(saved.id, incoming);
  const names = saved.product.itinerary![0]!.spots.map((spot) => spot.name);
  assert.deepEqual(names, ["甲景点", "丙景点"]);
  assert.ok(saved.product.itinerary![0]!.spots.every((spot) => spot.relation === "or"));
});

test("原 spotId 被显式写回时清除凭证", () => {
  const product = {
    manualReview: { itinerarySpotRemovals: [{ day: 1, name: "广济桥", removedAt: "now", spotId: SPOT_B }] },
    itinerary: [{ day: 1, spots: [{ spotId: SPOT_B, name: "完全改了名" }, { spotId: SPOT_C, name: "牌坊街" }] }],
  };
  assert.equal(clearReappearedTrustedOperatorItineraryRemovals(product), true);
  assert.deepEqual(product.manualReview.itinerarySpotRemovals, []);
});

test("旧版去空白 groupKey 的凭证仍能匹配当前景点名", () => {
  const product = {
    manualReview: { itinerarySpotRemovals: [{ day: 1, name: "乙 景点", removedAt: "now", groupKey: "or:1:甲景点\u001f乙景点" }] },
    itinerary: [{ day: 1, spots: [
      { name: "甲景点", relation: "or", timeOfDay: "morning" }, { name: "乙 景点", relation: "or", timeOfDay: "morning" },
    ] }],
  };
  const result = preserveItineraryRemovals(product, product);
  assert.deepEqual((result.itinerary as typeof product.itinerary)[0]!.spots.map((spot) => spot.name), ["甲景点"]);
});

const pingyao = (extra: Record<string, unknown> = {}) => ({ name: "平遥古城", poiName: "平遥古城", poiId: 9, kind: "attraction" as const, ...extra });
const night = (extra: Record<string, unknown> = {}) => ({ name: "平遥古城（夜景）", poiName: null, poiId: null, kind: "attraction" as const, ...extra });

test("删除「X（夜景）」不会在同一次保存里删掉同天带 ID 的「X」", () => {
  const product = buildProductSnapshot({ destination: "平遥", days: 1, productForm: "privateTour" }).product;
  product.itinerary = [{ day: 1, title: "平遥", description: "游览古城。", spots: [pingyao({ spotId: SPOT_A }), night({ spotId: SPOT_B })] }];
  const next = applyItinerarySpotRemove(product, { field: "itinerarySpotRemove", dayIndex: 0, spotIndex: 1 });
  assert.deepEqual((next.itinerary as Array<{ spots: Array<{ name: string }> }>)[0]!.spots.map((spot) => spot.name), ["平遥古城"]);
});

test("删除「X（夜景）」后模型不带 ID 重新生成：夜景仍被拦截，X 保留", () => {
  let saved = buildProductSnapshot({ destination: "平遥", days: 1, productForm: "privateTour" });
  saved.product.itinerary = [{ day: 1, title: "平遥", description: "游览古城。", spots: [pingyao({ spotId: SPOT_A }), night({ spotId: SPOT_B })] }];
  saved.product = applyItinerarySpotRemove(saved.product, { field: "itinerarySpotRemove", dayIndex: 0, spotIndex: 1 }) as typeof saved.product;
  const incoming = structuredClone(saved.product);
  incoming.itinerary![0]!.spots = [night(), pingyao({ poiName: null, poiId: null })];
  const service = new ProductMutationService({ getProduct: () => saved,
    updateProduct: (_id, next, status) => { saved = { ...saved, product: next as typeof saved.product, status: status ?? saved.status }; } });
  service.replace(saved.id, incoming);
  const spots = saved.product.itinerary![0]!.spots;
  assert.deepEqual(spots.map((spot) => [spot.name, spot.spotId, spot.poiId]), [["平遥古城", SPOT_A, 9]]);
});

test("模型只回传改名为「X（夜景）」的 X（继承了 X 的 ID）时，删除凭证仍拦截", () => {
  const product = {
    manualReview: { itinerarySpotRemovals: [{ day: 1, name: "平遥古城（夜景）", removedAt: "now", spotId: SPOT_B }] },
    itinerary: [{ day: 1, spots: [pingyao({ spotId: SPOT_A })] }],
  };
  const incoming = { ...structuredClone(product), itinerary: [{ day: 1, spots: [night({ spotId: SPOT_A })] }] };
  const result = preserveItineraryRemovals(product, incoming);
  assert.deepEqual((result.itinerary as Array<{ spots: unknown[] }>)[0]!.spots, []);
});

test("「XX体验」的删除凭证不删除同天幸存的「XX」", () => {
  const product = buildProductSnapshot({ destination: "西安", days: 1, productForm: "privateTour" }).product;
  product.itinerary = [{ day: 1, title: "西安", description: "游览。", spots: [
    { spotId: SPOT_A, name: "古城墙", poiName: null, poiId: null, kind: "attraction" },
    { spotId: SPOT_B, name: "古城墙体验", poiName: null, poiId: null, kind: "attraction" },
  ] }];
  const next = applyItinerarySpotRemove(product, { field: "itinerarySpotRemove", dayIndex: 0, spotIndex: 1 });
  assert.deepEqual((next.itinerary as Array<{ spots: Array<{ name: string }> }>)[0]!.spots.map((spot) => spot.name), ["古城墙"]);
});
