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

test("字段级回读：dailyDescription.title 不一致 → 失败", async () => {
  installHandlersForFieldMismatch({ title: () => "被改掉" });
  try {
    await ensureItineraryApi(makeFakePage() as any, baseProduct as any, "77035928");
    assert.fail("必须抛错");
  } catch (e) {
    assert.match(String(e), /第 1 天 回读 title 不一致/);
    assert.match(String(e), /被改掉/);
  }
});

test("字段级回读：景点 poiId 不一致 → 失败", async () => {
  installHandlersForFieldMismatch({ poi: () => [{ poiId: 99999, poiName: "古城" }] });
  try {
    await ensureItineraryApi(makeFakePage() as any, baseProduct as any, "77035928");
    assert.fail("必须抛错");
  } catch (e) {
    assert.match(String(e), /第 1 天 第 1 个景点 poiId 不一致/);
    assert.match(String(e), /期望=75924/);
    assert.match(String(e), /实际=99999/);
  }
});

test("字段级回读：景点 poiName 不一致 → 失败", async () => {
  installHandlersForFieldMismatch({ poi: () => [{ poiId: 75924, poiName: "改名后的景点" }] });
  try {
    await ensureItineraryApi(makeFakePage() as any, baseProduct as any, "77035928");
    assert.fail("必须抛错");
  } catch (e) {
    assert.match(String(e), /第 1 天 第 1 个景点 poiName 不一致/);
    assert.match(String(e), /改名后的景点/);
  }
});

test("字段级回读：酒店 hotelName 不一致 → 失败", async () => {
  installHandlersForFieldMismatch({ hotelName: () => "被改掉的酒店" });
  try {
    await ensureItineraryApi(makeFakePage() as any, baseProduct as any, "77035928");
    assert.fail("必须抛错");
  } catch (e) {
    assert.match(String(e), /第 1 天 第 1 个酒店 hotelName 不一致/);
    assert.match(String(e), /被改掉的酒店/);
  }
});

test("字段级回读：酒店 hotelTier 不一致 → 失败", async () => {
  installHandlersForFieldMismatch({});
  // 直接改 handler 在回读阶段让 grade.name 为空字符串。
  const original = routeHandlers["/restapi/soa2/20049/getTourDailyDetail.json"];
  routeHandlers["/restapi/soa2/20049/getTourDailyDetail.json"] = (() => {
    return () => {
      const inner = original({}) as { tourInfo: { tourDailyDescriptions: Array<{ tourDailyInfos: Array<Record<string, unknown>> }> } };
      const days = inner.tourInfo.tourDailyDescriptions;
      for (const d of days) {
        for (const info of d.tourDailyInfos) {
          if (info.activeType?.key === 1) {
            const hotels = info.tourDailyHotels as Array<{ hotel: { grade: { name: string } } }>;
            for (const h of hotels) h.hotel.grade.name = "";
          }
        }
      }
      return inner;
    };
  })();
  try {
    await ensureItineraryApi(makeFakePage() as any, baseProduct as any, "77035928");
    assert.fail("必须抛错");
  } catch (e) {
    assert.match(String(e), /第 1 天 第 1 个酒店 hotelTier 不一致/);
  }
});

test("字段级回读：餐饮 dinnerType key 顺序错乱 → 失败", async () => {
  installHandlersForFieldMismatch({ mealIncluded: false });
  // 改尾日第一段早餐的 dinnerType key 为 L
  const original = routeHandlers["/restapi/soa2/20049/getTourDailyDetail.json"];
  routeHandlers["/restapi/soa2/20049/getTourDailyDetail.json"] = (() => {
    return () => {
      const inner = original({}) as { tourInfo: { tourDailyDescriptions: Array<{ tourDailyInfos: Array<Record<string, unknown>> }> } };
      const days = inner.tourInfo.tourDailyDescriptions;
      for (const d of days.slice(1)) {
        const meals = d.tourDailyInfos.filter((i) => i.activeType?.key === 0);
        if (meals[0]) {
          (meals[0].tourDailyDinner as { dinnerType: { key: string } }).dinnerType.key = "L";
        }
      }
      return inner;
    };
  })();
  try {
    await ensureItineraryApi(makeFakePage() as any, baseProduct as any, "77035928");
    assert.fail("必须抛错");
  } catch (e) {
    assert.match(String(e), /第 2 天 第 1 段餐饮 dinnerType key 不一致/);
    assert.match(String(e), /期望=B/);
    assert.match(String(e), /实际=L/);
  }
});

test("字段级回读：餐饮 includeAdult 费用状态不一致 → 失败", async () => {
  installHandlersForFieldMismatch({ mealIncluded: false });
  // 把第一段餐饮 includeAdult 改成 I（费用包含），与业务期望 E 不一致。
  const original = routeHandlers["/restapi/soa2/20049/getTourDailyDetail.json"];
  routeHandlers["/restapi/soa2/20049/getTourDailyDetail.json"] = (() => {
    return () => {
      const inner = original({}) as { tourInfo: { tourDailyDescriptions: Array<{ tourDailyInfos: Array<Record<string, unknown>> }> } };
      const days = inner.tourInfo.tourDailyDescriptions;
      for (const d of days) {
        const meals = d.tourDailyInfos.filter((i) => i.activeType?.key === 0);
        if (meals[0]) {
          (meals[0].tourDailyDinner as { includeAdult: { key: string } }).includeAdult.key = "I";
        }
      }
      return inner;
    };
  })();
  try {
    await ensureItineraryApi(makeFakePage() as any, baseProduct as any, "77035928");
    assert.fail("必须抛错");
  } catch (e) {
    assert.match(String(e), /第 1 天 第 1 段餐饮 includeAdult 不一致/);
    assert.match(String(e), /期望=E/);
    assert.match(String(e), /实际=I/);
  }
});

test("字段级回读：早餐补充说明缺失 → 失败", async () => {
  installHandlersForFieldMismatch({});
  const original = routeHandlers["/restapi/soa2/20049/getTourDailyDetail.json"];
  routeHandlers["/restapi/soa2/20049/getTourDailyDetail.json"] = () => {
    const inner = original({}) as { tourInfo: { tourDailyDescriptions: Array<{ tourDailyInfos: Array<Record<string, unknown>> }> } };
    const breakfast = inner.tourInfo.tourDailyDescriptions[1]?.tourDailyInfos
      .find((info) => (info.tourDailyDinner as { dinnerType?: { key?: string } } | undefined)?.dinnerType?.key === "B");
    if (breakfast) breakfast.description = "";
    return inner;
  };
  await assert.rejects(
    ensureItineraryApi(makeFakePage() as any, baseProduct as any, "77035928"),
    /第 2 天 第 1 段早餐补充说明不一致/,
  );
});

test("字段级回读：其他 description 不一致 → 失败", async () => {
  installHandlersForFieldMismatch({ otherDescription: () => "描述被覆盖" });
  try {
    await ensureItineraryApi(makeFakePage() as any, baseProductWithUserOther() as any, "77035928");
    assert.fail("必须抛错");
  } catch (e) {
    assert.match(String(e), /第 1 天 回读「其他」description 不一致/);
    assert.match(String(e), /描述被覆盖/);
  }
});

test("字段级回读：服务时间 startOnBoardTime 不一致 → 失败", async () => {
  installHandlersForFieldMismatch({
    otherDescription: () => "下午 手作体验：体验手作",
    serviceStart: "09:30",
  });
  try {
    await ensureItineraryApi(makeFakePage() as any, baseProductWithUserOther() as any, "77035928");
    assert.fail("必须抛错");
  } catch (e) {
    assert.match(String(e), /第 1 天 回读服务时间 startOnBoardTime 不一致/);
    assert.match(String(e), /期望=08:00/);
    assert.match(String(e), /实际="09:30"/);
  }
});

test("字段级回读：服务时间 stopOnBoardTime 不一致 → 失败", async () => {
  installHandlersForFieldMismatch({
    otherDescription: () => "下午 手作体验：体验手作",
    serviceEnd: "21:00",
  });
  try {
    await ensureItineraryApi(makeFakePage() as any, baseProductWithUserOther() as any, "77035928");
    assert.fail("必须抛错");
  } catch (e) {
    assert.match(String(e), /第 1 天 回读服务时间 stopOnBoardTime 不一致/);
    assert.match(String(e), /实际="21:00"/);
  }
});

test("字段级回读：接机机场代码不一致 → 失败", async () => {
  installHandlersForFieldMismatch({ pickupAirport: "WRONG" });
  try {
    await ensureItineraryApi(makeFakePage() as any, baseProduct as any, "77035928");
    assert.fail("必须抛错");
  } catch (e) {
    assert.match(String(e), /第 1 天 接机机场代码不一致/);
    assert.match(String(e), /期望=LJG/);
    assert.match(String(e), /实际=WRONG/);
  }
});

test("字段级回读：接站火车站代码不一致 → 失败", async () => {
  installHandlersForFieldMismatch({ pickupTrain: "WRONG-TRAIN" });
  try {
    await ensureItineraryApi(makeFakePage() as any, baseProduct as any, "77035928");
    assert.fail("必须抛错");
  } catch (e) {
    assert.match(String(e), /第 1 天 接站火车站代码不一致/);
    assert.match(String(e), /期望=CN001LHM/);
  }
});

test("字段级回读：接机机场名称不一致 → 失败", async () => {
  installHandlersForFieldMismatch({ pickupName: "改名的机场" });
  try {
    await ensureItineraryApi(makeFakePage() as any, baseProduct as any, "77035928");
    assert.fail("必须抛错");
  } catch (e) {
    assert.match(String(e), /第 1 天 接机机场名称不一致/);
    assert.match(String(e), /改名的机场/);
  }
});

test("字段级回读：末日送机机场代码不一致 → 失败", async () => {
  installHandlersForFieldMismatch({ dropoffAirport: "WRONG-DROPOFF" });
  try {
    await ensureItineraryApi(makeFakePage() as any, baseProduct as any, "77035928");
    assert.fail("必须抛错");
  } catch (e) {
    assert.match(String(e), /末日（第 2 天）送机机场代码不一致/);
    assert.match(String(e), /实际=WRONG-DROPOFF/);
  }
});

test("字段级回读：末日送站火车站代码不一致 → 失败", async () => {
  installHandlersForFieldMismatch({ dropoffTrain: "WRONG-DROPOFF-TRAIN" });
  try {
    await ensureItineraryApi(makeFakePage() as any, baseProduct as any, "77035928");
    assert.fail("必须抛错");
  } catch (e) {
    assert.match(String(e), /末日（第 2 天）送站火车站代码不一致/);
    assert.match(String(e), /实际=WRONG-DROPOFF-TRAIN/);
  }
});

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
  assert.deepEqual(exp.days[0].pois, [{ poiId: 75924, poiName: "Old Town of Lijiang" }]);
  assert.deepEqual(exp.days[0].meals.map((m) => m.key), ["L", "S"]);
  assert.deepEqual(exp.days[1].meals.map((m) => m.key), ["B", "L"]);
  assert.equal(exp.days[1].meals[0].description, "是否含餐，以酒店房型为准。");
  assert.equal(exp.days[0].meals.every((m) => m.mealsIncluded === false), true);
  assert.deepEqual(exp.days[0].hotels, [{ hotelName: "和玺酒店", hotelTier: "当地4钻酒店/-4" }]);
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
