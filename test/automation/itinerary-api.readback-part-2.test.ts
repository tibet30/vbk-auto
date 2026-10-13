import { HOTEL_SELECTION_NOTE } from "../../src/shared/itinerary-service-copy.js";
// itinerary-api 的字段级回读契约：
//   - buildReadbackExpectations 把 product.itinerary + operations + stations
//     派生为完整期望（title / POI / 三餐 / 酒店 / 其他 / 服务时间 / 接送站）；
//   - verifyItineraryReadback 逐天逐字段比对，错误必含「第 N 天 / 字段 /
//     期望 / 实际」；
//   - 每个错配 case 注入对应字段的 readback 异常，断言错误信息命中具体关键词。
//
// 共享基础设施（fetch stub / fakePage / fixture / handler 工厂）放在
// itinerary-api.test-helpers.ts。

import test from "node:test";
import assert from "node:assert/strict";

import {
  ensureItineraryApi,
  verifyItineraryReadback,
} from "../../src/main/automation/ctrip/itinerary-api.ts";
import {
  buildReadbackExpectations,
} from "../../src/main/automation/ctrip/itinerary-api/itinerary-transform.ts";
import {
  baseProduct,
  baseProductNoHotel,
  clearRouteHandlers,
  installFetchStub,
  installHandlersForFieldMismatch,
  makeCandidate,
  makeFakePage,
  resetCallLog,
  routeHandlers,
  uninstallFetchStub,
} from "./itinerary-api.test-helpers.ts";

// ───────── 字段级回读错配覆盖 ─────────

test.beforeEach(() => {
  resetCallLog();
  installFetchStub();
});

test.afterEach(() => {
  clearRouteHandlers();
});

test.after(() => {
  uninstallFetchStub();
});

function baseProductWithUserOther() {
  return {
    ...baseProduct,
    itinerary: baseProduct.itinerary.map((day, index) => index === 0 ? {
      ...day,
      activities: [{
        time: "下午", title: "手作体验", detail: "体验手作", type: "other", source: "user", durationMinutes: 120,
      }],
    } : day),
  };
}

test("字段级回读：末日送机机场名称不一致 → 失败", async () => {
  installHandlersForFieldMismatch({ dropoffName: "送机改名" });
  try {
    await ensureItineraryApi(makeFakePage() as any, baseProduct as any, "77035928");
    assert.fail("必须抛错");
  } catch (e) {
    assert.match(String(e), /末日（第 2 天）送机机场名称不一致/);
    assert.match(String(e), /送机改名/);
  }
});

// ───────── buildReadbackExpectations 单测 ─────────

test("buildReadbackExpectations：title/POI/餐饮/酒店/其他/服务时间/接送站全部正确映射", () => {
  const stations = {
    pickupAir: makeCandidate("air", "LJG", "三义机场"),
    pickupTrain: makeCandidate("train", "CN001LHM", "丽江"),
    dropoffAir: makeCandidate("air", "LJG", "三义机场"),
    dropoffTrain: makeCandidate("train", "CN001LHM", "丽江"),
  };
  const exp = buildReadbackExpectations({
    itinerary: baseProduct.itinerary,
    operations: baseProduct.operations,
    stations,
  });
  assert.equal(exp.days.length, 2);
  assert.deepEqual(exp.days.map((d) => d.title), ["第1天：抵达丽江", "第2天：玉龙雪山"]);
  assert.deepEqual(exp.days.map((d) => d.useCar), [{ key: "B", name: "包车" }, { key: "B", name: "包车" }]);
  assert.deepEqual(exp.days[0].pois, [{ poiId: 75924, poiName: "Old Town of Lijiang", suffixKey: 13 }]);
  assert.deepEqual(exp.days[0].meals.map((m) => m.key), ["L", "S"]);
  assert.deepEqual(exp.days[1].meals.map((m) => m.key), ["B", "L"]);
  assert.equal(exp.days[1].meals[0].description, "是否含餐，以酒店房型为准。");
  assert.equal(exp.days[0].meals.every((m) => m.mealsIncluded === false), true);
  assert.deepEqual(exp.days[0].hotels, [{ hotelName: "使用携程平台酒店，自动匹配三钻、四钻、五钻酒店", hotelTier: undefined, selectionNote: HOTEL_SELECTION_NOTE }]);
  assert.equal(exp.days[0].other, undefined);
  assert.deepEqual(exp.days[0].serviceTime, { startTime: "08:00", endTime: "20:00" });
  assert.deepEqual(exp.pickup.airport, { code: "LJG", name: "三义机场" });
  assert.deepEqual(exp.pickup.train, { code: "CN001LHM", name: "丽江" });
  assert.equal(exp.requireHotels, true);
});

test("buildReadbackExpectations：无酒店 → hotels 为空且 requireHotels=false", () => {
  const exp = buildReadbackExpectations({
    itinerary: baseProductNoHotel.itinerary,
    operations: baseProductNoHotel.operations,
    stations: { pickupAir: makeCandidate("air", "LJG", "三义机场") },
  });
  assert.equal(exp.days[0].hotels.length, 0);
  assert.equal(exp.days[1].hotels.length, 0);
  assert.equal(exp.requireHotels, false);
});

test("buildReadbackExpectations：无住宿标记不生成酒店期望", () => {
  const exp = buildReadbackExpectations({
    itinerary: [{ ...baseProductNoHotel.itinerary[0], hotel: "无" }],
    operations: baseProductNoHotel.operations,
    stations: { pickupAir: makeCandidate("air", "LJG", "三义机场") },
  });

  assert.deepEqual(exp.days[0].hotels, []);
  assert.equal(exp.requireHotels, false);
});

test("buildReadbackExpectations：五家酒店候选只将前三家形成行程回读期望", () => {
  const exp = buildReadbackExpectations({
    itinerary: baseProduct.itinerary.map((day, index) => index === 0 ? {
      ...day,
      hotelCandidates: [
        { hotelName: "和玺酒店" }, { hotelName: "备选酒店二" }, { hotelName: "备选酒店三" },
        { hotelName: "资源候选四" }, { hotelName: "资源候选五" },
      ],
    } : day),
    operations: baseProduct.operations,
    stations: { pickupAir: makeCandidate("air", "LJG", "三义机场") },
  });
  assert.deepEqual(exp.days[0].hotels.map((hotel) => hotel.hotelName), ["使用携程平台酒店，自动匹配三钻、四钻、五钻酒店"]);
});

// ───────── verifyItineraryReadback 直接调用 ─────────

test("verifyItineraryReadback：字段完全匹配 → 返回 days/spots/meals/hotels/summary", async () => {
  installHandlersForFieldMismatch({});
  const stations = {
    pickupAir: makeCandidate("air", "LJG", "三义机场"),
    pickupTrain: makeCandidate("train", "CN001LHM", "丽江"),
    dropoffAir: makeCandidate("air", "LJG", "三义机场"),
    dropoffTrain: makeCandidate("train", "CN001LHM", "丽江"),
  };
  const expectations = buildReadbackExpectations({
    itinerary: baseProduct.itinerary,
    operations: baseProduct.operations,
    stations,
  });
  const result = await verifyItineraryReadback(makeFakePage() as any, "999999999999999999", expectations);
  assert.equal(result.days, 2);
  assert.equal(result.spots, 2);
  assert.equal(result.meals, 4);
  assert.equal(result.hotels, 2);
});

test("verifyItineraryReadback：无 POI 散团日允许没有景点节点", async () => {
  installHandlersForFieldMismatch({
    readbackDays: 1,
    title: () => "D1 瓜州 - 敦煌散团",
    poi: () => [],
    omitAttraction: () => true,
    hotelName: () => "",
    otherDescription: () => "下午 瓜州至敦煌散团：由瓜州前往敦煌，抵达后结束本次行程。",
    pickupAirport: "DNH",
    pickupName: "敦煌莫高国际机场",
    dropoffAirport: "DNH",
    dropoffName: "敦煌莫高国际机场",
  });
  const expectations = buildReadbackExpectations({
    itinerary: [{
      day: 1,
      title: "D1 瓜州 - 敦煌散团",
      spots: [],
      description: "由瓜州前往敦煌，抵达后结束本次行程。",
      hotel: "无",
      meals: "三餐自理",
      activities: [{
        time: "下午",
        title: "瓜州至敦煌散团",
        detail: "由瓜州前往敦煌，抵达后结束本次行程。",
        type: "other",
        source: "user",
      }],
    }],
    operations: { ...baseProductNoHotel.operations, mealsIncluded: false },
    stations: {
      pickupAir: makeCandidate("air", "DNH", "敦煌莫高国际机场"),
      dropoffAir: makeCandidate("air", "DNH", "敦煌莫高国际机场"),
    },
  });

  const result = await verifyItineraryReadback(makeFakePage() as any, "999999999999999999", expectations);
  assert.equal(result.days, 1);
  assert.equal(result.spots, 0);
  assert.equal(result.hotels, 0);
});
