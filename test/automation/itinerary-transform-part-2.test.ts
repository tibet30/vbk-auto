// 锁死 itinerary-transform 的契约：
//   - 输入 product.itinerary + operations + stations → 输出 VBK tourDailyDescriptions；
//   - 每种节点（接机/餐饮/景点/酒店/其他/送机）的 activeType.key 与 known fields 正确；
//   - 必填字段缺失抛错（含 day.title / spots[i].poiId）；
//   - 保留未知字段（tourDailyInfo 上的 pkgTourInfoId / versionNum / customStatus）；
//   - POI 字段保留（poiId / poiName / ticketType / relateSystemTicket）。
import test from "node:test";
import assert from "node:assert/strict";

import {
  buildDayDescription,
  buildReadbackExpectations,
  transformItinerary,
  type ProductItineraryDay,
  type ProductOperations,
  type ResolvedStations,
} from "../../src/main/automation/ctrip/itinerary-api/itinerary-transform.ts";

const baseStations: ResolvedStations = {
  pickupAir: { type: "air", id: "LJG", code: "LJG", name: "三义机场", raw: {} },
  pickupTrain: { type: "train", id: "CN001LHM", code: "CN001LHM", name: "丽江", raw: {} },
  dropoffAir: { type: "air", id: "LJG", code: "LJG", name: "三义机场", raw: {} },
  dropoffTrain: { type: "train", id: "CN001LHM", code: "CN001LHM", name: "丽江", raw: {} },
  source: "exact",
};

const baseOps: ProductOperations = {
  hotelTier: "当地4钻酒店/-4",
  pickupCity: "丽江",
  transport: "charter",
  reusePickupForDropoff: true,
  mealsIncluded: false,
};

function makeDay(overrides: Partial<ProductItineraryDay> = {}): ProductItineraryDay {
  return {
    day: 1,
    title: "丽江一日游",
    spots: [
      { name: "丽江古城", poiName: "丽江古城", poiId: 75924 },
    ],
    description: "自由活动",
    hotel: "丽江和玺酒店",
    meals: "早餐自理；午餐自理；晚餐自理",
    ...overrides,
  };
}

// ───────── 每天全节点转换 ─────────

test("免费景点使用 VBK 当前无需门票类型，收费景点默认含成人儿童首道门票", () => {
  const freeDay = makeDay({
    spots: [{
      name: "山西博物院",
      poiName: "山西博物院",
      poiId: 88189,
      poiType: { key: 3, name: "景点" },
      ticketType: { key: 2, name: "免费" },
    }],
  });
  const freePoi = transformItinerary({ itinerary: [freeDay], operations: baseOps, stations: baseStations })[0]
    .tourDailyInfos.find((info) => info.activeType?.key === 3).tourDailyPois[0];
  assert.deepEqual(freePoi.suffixName, { key: 11, name: "无需门票" });
  const paidDay = makeDay({
    spots: [{
      name: "收费景点",
      poiName: "收费景点",
      poiId: 123,
      poiType: { key: 3, name: "景点" },
      ticketType: { key: 1, name: "收费" },
    }],
  });
  const paidPoi = transformItinerary({ itinerary: [paidDay], operations: baseOps, stations: baseStations })[0]
    .tourDailyInfos.find((info) => info.activeType?.key === 3).tourDailyPois[0];
  assert.deepEqual(paidPoi.suffixName, { key: 13, name: "含成人儿童首道门票" });
});

test("外观且不上桥的景点保留 POI、顺序和说明", () => {
  const day = makeDay({
    spots: [
      { name: "广济桥", poiName: "广济桥", poiId: 1, ticketType: { key: 1, name: "收费" }, description: "远观广济桥（不上桥），欣赏代表性古桥景观。", timeOfDay: "morning" },
      { name: "收费景点", poiName: "收费景点", poiId: 2, ticketType: { key: 1, name: "收费" }, description: "入内参观。", timeOfDay: "morning" },
    ],
  });
  const attraction = transformItinerary({ itinerary: [day], operations: baseOps, stations: baseStations })[0]
    .tourDailyInfos.find((info) => info.activeType?.key === 3)!;
  assert.equal(attraction.description, "远观广济桥（不上桥），欣赏代表性古桥景观。；入内参观。");
  assert.deepEqual(attraction.tourDailyPois.map((poi: any) => poi.poi.poiId), [1, 2]);
  assert.deepEqual(attraction.tourDailyPois.map((poi: any) => poi.suffixName), [
    { key: 1, name: "外观" }, { key: 13, name: "含成人儿童首道门票" },
  ]);
});

test("未知 / 业务无关字段保留（customStatus / pkgTourInfoId / versionNum / directionWay）", () => {
  const out = transformItinerary({ itinerary: [makeDay()], operations: baseOps, stations: baseStations, refIdSeed: "1" });
  const attraction = out[0].tourDailyInfos.find((info) => info.activeType?.key === 3);
  assert.equal(attraction.customStatus, 0, "customStatus 必须保留");
  assert.equal(attraction.pkgTourInfoId, 0);
  assert.equal(attraction.versionNum, 0);
  assert.deepEqual(attraction.directionWay, { key: "", name: "" });
  assert.ok("recommendActivities" in attraction);
  assert.ok("tourDailyPackageGatherList" in attraction);
});

// ───────── 业务失败：必填字段缺失 ─────────

test("spots[i].poiId 缺失 → 抛错（含第几个、字段名）", () => {
  const day = makeDay({
    spots: [
      { name: "未命名", poiName: null, poiId: null },
    ],
  });
  assert.throws(
    () => transformItinerary({ itinerary: [day], operations: baseOps, stations: baseStations, refIdSeed: "1" }),
    /缺 poiId\/poiName/,
  );
});

test("day.title 缺失 → 抛错", () => {
  const day = makeDay({ title: "" });
  assert.throws(
    () => transformItinerary({ itinerary: [day], operations: baseOps, stations: baseStations, refIdSeed: "1" }),
    /title 缺失/,
  );
});

test("day.description 缺失不会阻断已有真实 POI 的日程", () => {
  const day = makeDay({ description: "" });
  assert.doesNotThrow(() => transformItinerary({ itinerary: [day], operations: baseOps, stations: baseStations, refIdSeed: "1" }));
});

test("空 itinerary 数组 → 抛错", () => {
  assert.throws(
    () => transformItinerary({ itinerary: [], operations: baseOps, stations: baseStations, refIdSeed: "1" }),
    /行程数组为空/,
  );
});

test("operations.pickupCity 缺失 → 抛错", () => {
  const ops: ProductOperations = { ...baseOps, pickupCity: undefined };
  assert.throws(
    () => transformItinerary({ itinerary: [makeDay()], operations: ops, stations: baseStations, refIdSeed: "1" }),
    /pickupCity 缺失/,
  );
});

test("接送站任一端无候选 → 抛错", () => {
  assert.throws(
    () => transformItinerary({
      itinerary: [makeDay()],
      operations: baseOps,
      stations: { ...baseStations, pickupAir: null, pickupTrain: null },
      refIdSeed: "1",
    }),
    /接送站搜索未返回任何可用候选/,
  );
  assert.throws(
    () => transformItinerary({
      itinerary: [makeDay()],
      operations: baseOps,
      stations: { ...baseStations, dropoffAir: null, dropoffTrain: null },
      refIdSeed: "1",
    }),
    /接送站搜索未返回任何可用候选/,
  );
});

test("refIdSeed 是日志关联 nonce，允许任意字符串（包括空），不再触发业务失败", () => {
  // 数字字符串、字母字符串、空串都应被接受；refId 与 refIdSeed 解耦。
  for (const seed of ["abc", "", "123", "v1.2-后缀"]) {
    const out = transformItinerary({ itinerary: [makeDay()], operations: baseOps, stations: baseStations, refIdSeed: seed });
    const poi = out[0].tourDailyInfos.find((info) => info.activeType?.key === 3).tourDailyPois[0];
    assert.equal(poi.refId, null);
  }
});

test("spots 和用户其他活动都为空 → 抛错", () => {
  const day = makeDay({ spots: [] });
  assert.throws(
    () => transformItinerary({ itinerary: [day], operations: baseOps, stations: baseStations, refIdSeed: "1" }),
    /缺少已验证景点或用户明确的其他活动/,
  );
});

// ───────── 已知 day 实测组合 ─────────

test("3 天行程：refId 一律为 null（不做去重 / 不参与协议字段）", () => {
  const days = [makeDay({ day: 1 }), makeDay({ day: 2 }), makeDay({ day: 3 })];
  const out = transformItinerary({ itinerary: days, operations: baseOps, stations: baseStations, refIdSeed: "100" });
  for (const day of out) {
    for (const info of day.tourDailyInfos) {
      for (const poi of info.tourDailyPois ?? []) assert.equal(poi.refId, null);
      for (const hotel of info.tourDailyHotels ?? []) assert.equal(hotel.refId, null);
      if (info.tourDailyTrain?.[0]) assert.equal(info.tourDailyTrain[0].refId, null);
      if (info.tourDailyTheme?.[0]) assert.equal(info.tourDailyTheme[0].refId, null);
      if (info.tourDailyDinner && "refId" in info.tourDailyDinner) assert.equal(info.tourDailyDinner.refId, null);
    }
  }
});

test("私家团包车日用车卡片只取「｜」后的内容，自由活动日不放用车卡片", () => {
  const days = [
    makeDay({ day: 1, title: "【出发地-丽江】专车服务｜故宫·天坛" }),
    makeDay({ day: 2, title: "自由活动｜丽江古城" }),
    makeDay({ day: 3, title: "专车送机｜丽江古城" }),
  ];
  const out = transformItinerary({ itinerary: days, operations: baseOps, stations: baseStations, privateTour: true });
  const cards = out.map((day) => day.tourDailyInfos.filter((info) => info.activeType?.key === 8));
  assert.equal(cards[0]!.length, 1);
  assert.equal(cards[0]![0]!.description, "故宫·天坛，全天用车");
  assert.equal(cards[1]!.length, 0);
  assert.equal(cards[2]![0]!.description, "丽江古城，全天用车");
  const expected = buildReadbackExpectations({ itinerary: days, operations: baseOps, stations: baseStations, privateTour: true });
  assert.deepEqual(expected.days.map((day) => day.transport?.description), ["故宫·天坛，全天用车", undefined, "丽江古城，全天用车"]);
  const group = transformItinerary({ itinerary: [days[1]!], operations: baseOps, stations: baseStations });
  assert.equal(group[0]!.tourDailyInfos.find((info) => info.activeType?.key === 8)?.description, "自由活动｜丽江古城，全天用车");
});
