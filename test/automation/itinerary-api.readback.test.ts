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

test("字段级回读：平台酒店收敛备选（期望 3 实际 1）→ 通过", async () => {
  installHandlersForFieldMismatch({});
  // 行程酒店始终为携程平台酒店：后端可收敛「或」备选，实际槽位必须能对应期望候选。
  const product = {
    ...baseProduct,
    itinerary: baseProduct.itinerary.map((day, index) => index === 0 ? {
      ...day,
      hotelCandidates: [{ hotelName: "和玺酒店" }, { hotelName: "备选酒店二" }, { hotelName: "备选酒店三" }],
    } : day),
  };
  const result = await ensureItineraryApi(makeFakePage() as any, product as any, "77035928");
  assert.equal(result.savedHotels, 2);
});

test("字段级回读：平台酒店模式允许 VBK 将酒店槽位规范化为自选酒店", async () => {
  installHandlersForFieldMismatch({});
  const original = routeHandlers["/restapi/soa2/20049/getTourDailyDetail.json"];
  routeHandlers["/restapi/soa2/20049/getTourDailyDetail.json"] = () => {
    const inner = original({}) as { tourInfo: { tourDailyDescriptions: Array<{ tourDailyInfos: Array<Record<string, unknown>> }> } };
    const days = inner.tourInfo.tourDailyDescriptions;
    for (const d of days) {
      for (const info of d.tourDailyInfos) {
        if (info.activeType?.key === 1) {
          info.useSegmentConfig = true;
          info.description = `使用携程平台酒店，自动匹配三钻、四钻、五钻酒店\n${HOTEL_SELECTION_NOTE}`;
          const hotels = info.tourDailyHotels as Array<{ hotel: { hotelName: string } }>;
          for (const h of hotels) h.hotel.hotelName = "自选酒店";
        }
      }
    }
    return inner;
  };
  try {
    const result = await ensureItineraryApi(makeFakePage() as any, baseProduct as any, "77035928");
    assert.equal(result.savedHotels, 2);
  } finally {
    routeHandlers["/restapi/soa2/20049/getTourDailyDetail.json"] = original;
  }
});

test("字段级回读：平台酒店自动匹配说明缺失 → 失败", async () => {
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
            info.description = HOTEL_SELECTION_NOTE;
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
    assert.match(String(e), /第 1 天 平台酒店匹配说明或来源不一致/);
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
