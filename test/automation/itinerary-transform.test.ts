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

test("有真实 POI 且无未匹配用户活动时，不追加其他节点", () => {
  const days = [makeDay({ day: 1, title: "第1天" }), makeDay({ day: 2, title: "第2天" }), makeDay({ day: 3, title: "第3天" })];
  const out = transformItinerary({ itinerary: days, operations: baseOps, stations: baseStations, refIdSeed: "1" });
  assert.equal(out.length, 3);
  // 首日：接机 + 上午景点 + 午餐 + 晚餐 + 酒店 = 5（首日不排早餐）
  assert.equal(out[0].tourDailyInfos.length, 5, "首日必须有接机节点，且不应出现早餐");
  assert.equal(out[0].tourDailyInfos[0].activeType?.key, 25, "首日首节点必须是集合（接机/站）");
  assert.equal(out[0].tourDailyInfos[0].activeType?.name, "集合");
  // 末日
  const last = out[out.length - 1];
  assert.equal(last.tourDailyInfos[last.tourDailyInfos.length - 1].activeType?.key, 26, "末日尾节点必须是解散（送机/站）");
  // 中间天不应该有接机 / 送机
  const middle = out[1];
  const transportInMiddle = middle.tourDailyInfos.filter((info) => [25, 26].includes(info.activeType?.key));
  assert.equal(transportInMiddle.length, 0, "中间天不应该有交通节点");
});

test("每天至少包含 1 个景点节点，上午/下午节点合计 POI 数量 == spots 长度", () => {
  const day = makeDay({
    spots: [
      { name: "玉龙雪山", poiName: "玉龙雪山", poiId: 10543884 },
      { name: "蓝月谷", poiName: "蓝月谷", poiId: 10523034 },
    ],
  });
  const out = transformItinerary({ itinerary: [day], operations: baseOps, stations: baseStations, refIdSeed: "1" });
  const attractions = out[0].tourDailyInfos.filter((info) => info.activeType?.key === 3);
  assert.equal(attractions.length, 2, "两个景点应拆为上午、下午两个节点");
  const pois = attractions.flatMap((attraction) => attraction.tourDailyPois);
  assert.equal(pois.length, 2);
  for (const poi of pois) {
    assert.ok(typeof poi.poi.poiId === "number" && poi.poi.poiId > 0);
    assert.ok(poi.poi.poiName);
  }
});

test("餐饮按首尾日与时段排列：首日无早餐，尾日无晚餐，午餐位于上午/下午景点之间", () => {
  const days = [
    makeDay({ day: 1, spots: [{ name: "上午景点", poiName: "上午景点", poiId: 1 }, { name: "下午景点", poiName: "下午景点", poiId: 2 }] }),
    makeDay({ day: 2, spots: [{ name: "中段景点", poiName: "中段景点", poiId: 3 }] }),
    makeDay({ day: 3, spots: [{ name: "尾日景点", poiName: "尾日景点", poiId: 4 }], hotel: "" }),
  ];
  const out = transformItinerary({ itinerary: days, operations: baseOps, stations: baseStations, refIdSeed: "1" });
  const keys = (day: typeof out[number]) => day.tourDailyInfos.map((info) =>
    info.activeType?.key === 0 ? info.tourDailyDinner?.dinnerType?.key : info.activeType?.key,
  );
  assert.deepEqual(keys(out[0]), [25, 3, "L", 3, "S", 1]);
  assert.deepEqual(keys(out[1]), ["B", 3, "L", "S", 1]);
  assert.deepEqual(keys(out[2]), ["B", 3, "L", 26]);
  const attractions = out[0].tourDailyInfos.filter((info) => info.activeType?.key === 3);
  assert.deepEqual(attractions.map((info) => info.takeoffTime?.name), ["上午", "下午"]);
});

test("mealsIncluded=true 仅影响早餐权益；午餐和晚餐仍为自理", () => {
  const ops = { ...baseOps, mealsIncluded: true };
  const out = transformItinerary({ itinerary: [
    makeDay({ day: 1 }),
    // 模拟没有 mealDescriptions 的历史草稿重跑；转换终点仍必须补上早餐说明。
    makeDay({ day: 2 }),
    makeDay({ day: 3 }),
  ], operations: ops, stations: baseStations, refIdSeed: "1" });
  const meals = out[1].tourDailyInfos.filter((info) => info.activeType?.key === 0);
  assert.deepEqual(meals.map((meal) => meal.tourDailyDinner?.dinnerType?.key), ["B", "L", "S"]);
  assert.deepEqual(meals.map((meal) => meal.tourDailyDinner?.includeAdult?.key), ["I", "E", "E"]);
  assert.equal(meals[0].description, "是否含餐，以酒店房型为准。", "早餐补充说明必须写入平台对应输入框");
  for (const meal of meals) {
    assert.equal(meal.tourDailyDinner?.includeChild?.key, "E", "儿童固定费用自理");
  }
});

test("酒店节点：day.hotel 非空时产出 activeType=1 节点 + tourDailyHotels 长度=1 + hotelName 回写", () => {
  const out = transformItinerary({
    itinerary: [makeDay({ hotel: "丽江和玺酒店" })],
    operations: baseOps,
    stations: baseStations,
    refIdSeed: "1",
  });
  const hotel = out[0].tourDailyInfos.find((info) => info.activeType?.key === 1);
  assert.ok(hotel, "hotel 非空必须有酒店节点");
  assert.equal(hotel.tourDailyHotels.length, 1);
  assert.equal(hotel.tourDailyHotels[0].hotel.hotelName, "丽江和玺酒店");
  // 钻级从 operations.hotelTier 派生
  assert.equal(hotel.tourDailyHotels[0].hotel.grade.name, "当地4钻酒店/-4");
  assert.equal(hotel.tourDailyHotels[0].hotel.grade.key, null, "酒店钻级 key 留空（业务 VBK 用 grade.name 匹配）");
});

test("酒店节点：day.hotel 为空时不产出酒店节点", () => {
  const out = transformItinerary({
    itinerary: [makeDay({ hotel: "" })],
    operations: baseOps,
    stations: baseStations,
    refIdSeed: "1",
  });
  const hotels = out[0].tourDailyInfos.filter((info) => info.activeType?.key === 1);
  assert.equal(hotels.length, 0, "无酒店信息时不应产出节点");
});

test("接机 / 送机节点：集合/解散卡片与真实 stations 结构一致", () => {
  const days = [makeDay({ day: 1 }), makeDay({ day: 2 })];
  const out = transformItinerary({ itinerary: days, operations: baseOps, stations: baseStations, refIdSeed: "1" });
  const pickup = out[0].tourDailyInfos[0];
  assert.equal(pickup.activeType?.key, 25);
  assert.deepEqual(pickup.tourDailyPackageGatherList[0].airports, [{ code: "LJG", name: "三义机场" }]);
  assert.equal(pickup.tourDailyPackageGatherList[0].trainStations[0].locationCode, "CN001LHM");
  assert.equal(pickup.tourDailyPackageGatherList[0].serviceAllDay, true);
  const dropoff = out[1].tourDailyInfos[out[1].tourDailyInfos.length - 1];
  assert.equal(dropoff.activeType?.key, 26);
  assert.deepEqual(dropoff.tourDailyPackageDismissList[0].airports, [{ code: "LJG", name: "三义机场" }]);
  assert.equal(dropoff.tourDailyPackageDismissList[0].trainStations[0].locationCode, "CN001LHM");
  assert.equal(dropoff.tourDailyPackageDismissList[0].serviceAllDay, true);
});

test("接机只有 train 时写入 trainStation + 上下车点", () => {
  const stations: ResolvedStations = {
    pickupTrain: { type: "train", id: "CN001NJH", code: "CN001NJH", name: "南京", raw: {} },
    dropoffTrain: { type: "train", id: "CN001NJH", code: "CN001NJH", name: "南京", raw: {} },
  };
  const out = transformItinerary({
    itinerary: [makeDay({ day: 1 }), makeDay({ day: 2 })],
    operations: { ...baseOps, pickupCity: "南京" },
    stations,
    refIdSeed: "1",
  });
  assert.equal(out[0].tourDailyInfos[0].tourDailyPackageGatherList[0].trainStations[0].locationCode, "CN001NJH");
  assert.deepEqual(out[0].tourDailyInfos[0].tourDailyPackageGatherList[0].airports, []);
  assert.equal(out[1].tourDailyInfos.at(-1).tourDailyPackageDismissList[0].trainStations[0].locationCode, "CN001NJH");
});

test("已有真实 POI 且没有未匹配用户活动时，不写入其他 / 自由活动节点", () => {
  const out = transformItinerary({
    itinerary: [makeDay({ description: "自由活动：漫步古城" })],
    operations: baseOps,
    stations: baseStations,
    refIdSeed: "1",
  });
  const other = out[0].tourDailyInfos.find((info) => info.activeType?.key === 7);
  assert.equal(other, undefined);
});

test("AI 行程 description 不会被自动写为其他 / 自由活动", () => {
  const out = transformItinerary({
    itinerary: [
      makeDay({ day: 1, description: "上午游览丽江古城" }),
      makeDay({ day: 2, description: "继续游览玉龙雪山" }),
    ],
    operations: baseOps,
    stations: baseStations,
    refIdSeed: "1",
  });
  assert.equal(out[0].tourDailyInfos.some((info) => info.activeType?.key === 7), false);
  assert.equal(out[1].tourDailyInfos.some((info) => info.activeType?.key === 7), false);
});

test("orderDay 严格 1..N 且 dailyDescription 来自 day.title", () => {
  const days = [
    makeDay({ day: 5, title: "A" }),
    makeDay({ day: 6, title: "B" }),
  ];
  const out = transformItinerary({ itinerary: days, operations: baseOps, stations: baseStations, refIdSeed: "1" });
  assert.deepEqual(out.map((d) => d.orderDay), [1, 2]);
  assert.deepEqual(out.map((d) => d.dailyDescription), ["A", "B"]);
});

test("refId 一律为 null（真实 detail 样本对齐；不允许伪造字符串）", () => {
  const day = makeDay();
  const out = transformItinerary({ itinerary: [day], operations: baseOps, stations: baseStations, refIdSeed: "1" });
  for (const info of out[0].tourDailyInfos) {
    for (const poi of info.tourDailyPois ?? []) {
      assert.equal(poi.refId, null);
    }
    for (const hotel of info.tourDailyHotels ?? []) {
      assert.equal(hotel.refId, null);
    }
    for (const train of info.tourDailyTrains ?? []) {
      assert.equal(train.refId, null);
    }
    for (const theme of info.tourDailyThemes ?? []) {
      assert.equal(theme.refId, null);
    }
    if (info.tourDailyDinner && "refId" in info.tourDailyDinner) {
      assert.equal(info.tourDailyDinner.refId, null);
    }
  }
  // 同样的种子不再影响 refId（因为它就是 null）。
  const out2 = transformItinerary({ itinerary: [day], operations: baseOps, stations: baseStations, refIdSeed: "2" });
  const aPoi = out[0].tourDailyInfos.find((info) => info.activeType?.key === 3).tourDailyPois[0];
  const bPoi = out2[0].tourDailyInfos.find((info) => info.activeType?.key === 3).tourDailyPois[0];
  assert.equal(aPoi.refId, bPoi.refId);
});

test("POI 节点保留 VBK 模板关键字段：poiId / poiName / ticketType / relateSystemTicket", () => {
  const out = transformItinerary({
    itinerary: [makeDay({ spots: [{ name: "丽江古城", poiName: "Old Town of Lijiang", poiId: 75924 }] })],
    operations: baseOps,
    stations: baseStations,
    refIdSeed: "1",
  });
  const attraction = out[0].tourDailyInfos.find((info) => info.activeType?.key === 3);
  const poi = attraction.tourDailyPois[0].poi;
  assert.equal(poi.poiId, 75924);
  assert.equal(poi.poiName, "Old Town of Lijiang");
  assert.equal(poi.relateSystemTicket?.key, "F", "relateSystemTicket.key=F（否）保留");
  assert.equal(poi.relateSystemTicket?.name, "否");
  assert.ok("ticketType" in poi, "ticketType 字段必须保留");
});

test("免费景点使用 VBK 当前无需门票类型，收费景点保持不含门票", () => {
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
  assert.deepEqual(paidPoi.suffixName, { key: 7, name: "不含门票" });
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
