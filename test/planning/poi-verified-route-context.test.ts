import assert from "node:assert/strict";
import test from "node:test";
import { buildPoiContextForItineraryDay } from "../../src/main/planning/poi-context.js";
import { isPlanningPoiCandidateInContext } from "../../src/main/planning/poi-auto-selection.js";

const userIdea = [
  "Day1 出发地-哈尔滨市",
  "Day2 漠河接站-龙江第一湾-中国最北点-乌苏里浅滩-北红村篝火晚会",
  "Day3 泼水成冰-马拉爬犁-鄂温克使鹿部落-圣诞村-滑雪2小时-北极村",
  "Day4 北极星广场-松苑公园-五·六火灾纪念馆-漠河舞厅",
].join("\n");

const verified = (name: string, poiId: number, city = "大兴安岭", province = "黑龙江") => ({
  name, poiName: name, poiId, province, city, district: "漠河", kind: "attraction",
});

function fixture() {
  return {
    basicInfo: { meetingCity: "哈尔滨", destinationCity: "哈尔滨", province: "黑龙江", userIdea },
    itinerary: [
      { day: 1, title: "哈尔滨市", hotelCity: "哈尔滨", spots: [] },
      { day: 2, title: "漠河接站与北红村", hotelCity: "哈尔滨", spots: [
        verified("龙江第一湾", 91861), verified("中国最北点", 56810159),
      ] },
      { day: 3, title: "北极村冬日体验", hotelCity: "哈尔滨", spots: [
        { name: "鄂温克使鹿部落", kind: "attraction" },
        { name: "圣诞村", kind: "attraction" },
      ], activities: [{ type: "transport", title: "北极村行政地点与交通衔接", detail: "北极村" }] },
      { day: 4, title: "漠河县城", spots: [
        verified("北极星广场", 18456561), verified("松苑公园", 86679),
      ] },
    ],
  };
}

const christmas = {
  index: 0, poiName: "北极圣诞村景区", poiId: 18119428, selectable: true, textFields: [],
  province: "黑龙江", city: "大兴安岭", district: "漠河",
};
const reindeer = {
  ...christmas, poiName: "北极村旅游景区-鄂温克驯鹿园", poiId: 71944168,
};

test("哈尔滨锚点下，夹中日只用左右已核验原路线的同省同城共识", () => {
  const product = fixture();
  const day = product.itinerary[2]!;
  const context = buildPoiContextForItineraryDay(product, "哈尔滨", day);
  assert.deepEqual(context, { destinationCity: "大兴安岭", province: "黑龙江" });
  assert.equal(isPlanningPoiCandidateInContext(christmas, context, product, "圣诞村", [christmas]), true);
  assert.equal(isPlanningPoiCandidateInContext(reindeer, context, product, "鄂温克使鹿部落", [reindeer]), true);
});

test("同日已有一致可信的原路线 POI 地域时优先使用，支持随后景点绑定", () => {
  const product = fixture();
  product.itinerary[0]!.spots = [verified("哈尔滨市", 1, "齐齐哈尔")];
  product.itinerary[2]!.spots = [verified("北极村", 86672, "齐齐哈尔")];
  assert.deepEqual(buildPoiContextForItineraryDay(product, "哈尔滨", product.itinerary[1]), {
    destinationCity: "大兴安岭", province: "黑龙江",
  });
});

test("旧完整 POI 只有该日原文同时佐证名称和城市或区县时才可作地域证据", () => {
  const mutations = [
    (product: ReturnType<typeof fixture>) => { product.itinerary[1]!.spots = [verified("龙江第一湾", 91861, "哈尔滨")]; },
    (product: ReturnType<typeof fixture>) => {
      product.itinerary[1]!.spots = [{ ...verified("龙江第一湾", 91861, "齐齐哈尔"), district: "龙沙" }];
    },
    (product: ReturnType<typeof fixture>) => { product.itinerary[1]!.spots = [verified("北极星广场", 18456561)]; },
    (product: ReturnType<typeof fixture>) => { product.basicInfo.userIdea = "哈尔滨、漠河四日路线"; },
  ];
  for (const [index, mutate] of mutations.entries()) {
    const product = fixture();
    mutate(product);
    assert.deepEqual(buildPoiContextForItineraryDay(product, "哈尔滨", product.itinerary[1]), {
      destinationCity: "哈尔滨", province: "黑龙江",
    }, `stale evidence ${index}`);
  }
});

test("D3 新绑定自身没有城市或区县原文佐证，不能在缺少双侧共识时自证", () => {
  const product = fixture();
  product.itinerary[2]!.spots.unshift(verified("圣诞村", 18119428));
  product.itinerary[1]!.spots = [];
  assert.deepEqual(buildPoiContextForItineraryDay(product, "哈尔滨", product.itinerary[2]), {
    destinationCity: "哈尔滨", province: "黑龙江",
  });
});

test("酒店、任意同省、单侧邻居、缺失字段或左右冲突都不能放宽城市锚点", () => {
  const variants = [
    (product: ReturnType<typeof fixture>) => { product.itinerary[3]!.spots = []; },
    (product: ReturnType<typeof fixture>) => { delete product.itinerary[1]!.spots[0]!.city; },
    (product: ReturnType<typeof fixture>) => { product.itinerary[3]!.spots = [verified("北极星广场", 18456561, "齐齐哈尔")]; },
    (product: ReturnType<typeof fixture>) => { product.itinerary[1]!.spots[1]!.city = "齐齐哈尔"; },
    (product: ReturnType<typeof fixture>) => {
      product.itinerary[1]!.spots = [verified("龙江第一湾", 91861, "大兴安岭", "吉林")];
      product.itinerary[3]!.spots = [verified("北极星广场", 18456561, "大兴安岭", "吉林")];
    },
  ];
  for (const [index, mutate] of variants.entries()) {
    const product = fixture();
    mutate(product);
    assert.deepEqual(buildPoiContextForItineraryDay(product, "哈尔滨", product.itinerary[2]), {
      destinationCity: "哈尔滨", province: "黑龙江",
    }, `negative variant ${index}`);
  }
});

test("结构化克隆的目标日仍按原始 day 定位，不能依赖对象引用", () => {
  const product = fixture();
  const clonedDay = structuredClone(product.itinerary[2]);
  assert.deepEqual(buildPoiContextForItineraryDay(product, "哈尔滨", clonedDay), {
    destinationCity: "大兴安岭", province: "黑龙江",
  });
});

test("路线共识仍拒绝外省、同省异城和地域缺失候选", () => {
  const product = fixture();
  const context = buildPoiContextForItineraryDay(product, "哈尔滨", product.itinerary[2]);
  for (const candidate of [
    { ...christmas, province: "吉林" },
    { ...christmas, city: "齐齐哈尔" },
    { ...christmas, province: undefined },
    { ...christmas, city: undefined },
  ]) {
    assert.equal(isPlanningPoiCandidateInContext(candidate, context, product, "圣诞村", [candidate]), false);
  }
});
