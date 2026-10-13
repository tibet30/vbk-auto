// itinerary-api 的"编排 + 单接口步骤"契约：
//   - pickAirport / pickTrain 候选排序；
//   - countItineraryApiSpots 兼容统计；
//   - ensureItineraryApi 主路径按已采样草稿协议调用（suggestAirport/suggestTrainStation
//     → getProductTourInfoList → getTourDailyDetail → checkTourDaily(2) →
//     saveTourDailyDetail(2) → saveProductTourInfo(2) → draft 回读校验）；
//   - 失败契约：check(2) 响应缺 tourDaily、saveTourDailyDetail 响应缺 tourInfo、
//     接送站空、poiId 缺失、回读 day 数不一致 → 立即失败；
//   - 成功结果字段完整：tourInfoId 等所有字段都在。
//
// 共享基础设施（fetch stub / fakePage / fixture / handler 工厂）放在
// itinerary-api.test-helpers.ts。

import test from "node:test";
import assert from "node:assert/strict";

import {
  countItineraryApiSpots,
  ensureItineraryApi,
  pickAirport,
  pickTrain,
  resolveStationsForItinerary,
} from "../../src/main/automation/ctrip/itinerary-api.ts";
import {
  baseProduct,
  baseProductNoHotel,
  callLog,
  clearRouteHandlers,
  installFetchStub,
  installHandlersForFieldMismatch,
  makeCandidate,
  makeFakePage,
  makeHandlers,
  makeReadbackDays,
  resetCallLog,
  routeHandlers,
  uninstallFetchStub,
} from "./itinerary-api.test-helpers.ts";

// ───────── pickAirport / pickTrain（纯函数） ─────────

test("pickAirport：仅选择名称明确匹配城市的候选，拒绝跨城首项", () => {
  assert.equal(pickAirport([], "丽江"), null);
  assert.equal(pickAirport([makeCandidate("air", "XMN", "高崎国际机场")], "潮州"), null, "单个跨城机场也不得自动选用");
  const exact = pickAirport([
    makeCandidate("air", "PVG", "浦东国际机场"),
    makeCandidate("air", "SHA", "上海"),
  ], "上海");
  assert.equal(exact?.code, "SHA", "精确同名 city=上海 必须命中");
  const primary = pickAirport([
    makeCandidate("air", "WUX", "苏南硕放国际机场"),
    makeCandidate("air", "SHA", "上海"),
  ], "苏州");
  assert.equal(primary, null, "苏州不能因国际机场字样误选无锡");
  const fallback = pickAirport([
    makeCandidate("air", "FOO", "城市机场"),
    makeCandidate("air", "BAR", "BAR"),
  ], "未知");
  assert.equal(fallback, null, "都未匹配时拒绝首项");
});

test("pickTrain：仅选择名称明确匹配城市的候选", () => {
  assert.equal(pickTrain([], "南京"), null);
  const one = pickTrain([makeCandidate("train", "CN001NJH", "南京")], "南京");
  assert.ok(one && one.code === "CN001NJH");
  const exact = pickTrain([
    makeCandidate("train", "CN001SHH", "上海"),
    makeCandidate("train", "CN001AOH", "上海虹桥"),
  ], "上海");
  assert.equal(exact?.code, "CN001SHH", "精确同名 city=上海 命中");
  const fallback = pickTrain([
    makeCandidate("train", "CN001XXX", "其他站"),
    makeCandidate("train", "CN001YYY", "其他站2"),
  ], "未知");
  assert.equal(fallback, null);
});

test("已核验跨城端点按 name 重查并精确匹配 code/name，接送站可不同", async () => {
  routeHandlers["/restapi/soa2/20049/suggestAirport"] = (body) => ({
    ResponseStatus: { Ack: "Success", Errors: [] },
    airports: ({
      "揭阳潮汕机场": [{ code: "SWA", name: "揭阳潮汕机场" }],
      "深圳宝安国际机场": [{ code: "SZX", name: "深圳宝安国际机场" }],
    } as Record<string, unknown[]>)[body.keyword] ?? [],
  });
  routeHandlers["/restapi/soa2/20049/suggestTrainStation"] = (body) => ({
    ResponseStatus: { Ack: "Success", Errors: [] },
    trainStations: ({
      "潮汕": [{ stationNo: 215, locationCode: "CN001CBQ", stationName: "潮汕" }],
      "深圳北": [{ stationNo: 216, locationCode: "CN001IOQ", stationName: "深圳北" }],
    } as Record<string, unknown[]>)[body.keyword] ?? [],
  });

  const stations = await resolveStationsForItinerary(makeFakePage() as any, {
    pickupCity: "潮州",
    endpointPlan: {
      arrivalCity: "潮州", departureCity: "深圳", resolvedAt: "2026-09-30T00:00:00.000Z",
      flight: {
        arrival: { code: "SWA", name: "揭阳潮汕机场" },
        departure: { code: "SZX", name: "深圳宝安国际机场" },
      },
      train: {
        arrival: { code: "CN001CBQ", name: "潮汕", resourceKey: "215" },
        departure: { code: "CN001IOQ", name: "深圳北", resourceKey: "216" },
      },
    },
  });

  assert.equal(stations.pickupAir?.code, "SWA");
  assert.equal(stations.pickupTrain?.code, "CN001CBQ");
  assert.equal(stations.dropoffAir?.code, "SZX");
  assert.equal(stations.dropoffTrain?.code, "CN001IOQ");
  assert.deepEqual(callLog.slice(0, 4).map((call) => call.body.keyword).sort(), [
    "揭阳潮汕机场", "深圳宝安国际机场", "潮汕", "深圳北",
  ].sort());
});

test("已核验端点重查到 code/name 变化时拒绝写错站并展示实际候选", async () => {
  routeHandlers["/restapi/soa2/20049/suggestAirport"] = () => ({
    ResponseStatus: { Ack: "Success", Errors: [] },
    airports: [{ code: "SWA2", name: "揭阳潮汕国际机场" }],
  });
  routeHandlers["/restapi/soa2/20049/suggestTrainStation"] = () => ({
    ResponseStatus: { Ack: "Success", Errors: [] }, trainStations: [],
  });

  await assert.rejects(
    () => resolveStationsForItinerary(makeFakePage() as any, {
      pickupCity: "潮州",
      endpointPlan: {
        arrivalCity: "潮州", departureCity: "潮州",
        flight: {
          arrival: { code: "SWA", name: "揭阳潮汕机场" },
          departure: { code: "SWA", name: "揭阳潮汕机场" },
        },
      },
    }),
    /SWA2.*揭阳潮汕国际机场|揭阳潮汕国际机场.*SWA2/,
  );
});

test("无已核验端点时单个跨城候选也 fail closed", async () => {
  routeHandlers["/restapi/soa2/20049/suggestAirport"] = () => ({
    ResponseStatus: { Ack: "Success", Errors: [] }, airports: [{ code: "XMN", name: "高崎国际机场" }],
  });
  routeHandlers["/restapi/soa2/20049/suggestTrainStation"] = () => ({
    ResponseStatus: { Ack: "Success", Errors: [] }, trainStations: [],
  });

  const stations = await resolveStationsForItinerary(makeFakePage() as any, { pickupCity: "潮州" });
  assert.equal(stations.pickupAir, null);
  assert.equal(stations.pickupTrain, null);
  assert.equal(stations.dropoffAir, null);
  assert.equal(stations.dropoffTrain, null);
});

// ───────── countItineraryApiSpots 兼容 ─────────

test("countItineraryApiSpots 只统计景点节点里的 POI", () => {
  const detail = {
    tourInfo: {
      tourDailyDescriptions: [{
        tourDailyInfos: [
          { activeType: { key: 1, name: "酒店" }, tourDailyPois: [{}, {}] },
          { activeType: { key: 3, name: "景点" }, tourDailyPois: [{}, {}] },
          { activeType: { key: 3, name: "景点" }, tourDailyPois: [{}] },
        ],
      }],
    },
  };
  assert.equal(countItineraryApiSpots(detail), 3);
});

// ───────── 主路径：调用顺序契约 ─────────

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

test("ensureItineraryApi 只按已采样 draft 协议 check(2) → detail(2) → association(2)，并回读 draft", async () => {
  installHandlersForFieldMismatch({ hotelName: () => "", otherDescription: () => "自由活动", serviceStart: "08:00", serviceEnd: "20:00", title: (i) => i === 0 ? "第1天" : "第2天" });
  const result = await ensureItineraryApi(makeFakePage() as any, baseProductNoHotel as any, "77035928");
  const sequence = callLog.map((c) => c.endpoint);
  const expect = [
    "/restapi/soa2/20049/suggestAirport",
    "/restapi/soa2/20049/suggestTrainStation",
    "/restapi/soa2/20049/suggestPoi",
    "/restapi/soa2/20049/suggestPoi",
    "/restapi/soa2/15638/getProductTourInfoList",
    "/restapi/soa2/20049/getTourDailyDetail.json",
    "/restapi/soa2/15638/checkTourDaily",
    "/restapi/soa2/20049/saveTourDailyDetail.json",
    "/restapi/soa2/15638/saveProductTourInfo",
    "/restapi/soa2/15638/getProductTourInfoList",
    "/restapi/soa2/20049/getTourDailyDetail.json",
  ];
  assert.deepEqual(sequence, expect, `实际顺序: ${sequence.join(", ")}`);
  assert.equal(result.days, 2);
  assert.equal(result.savedSpots, 2);
  assert.equal(result.savedMeals, 4, "首日无早餐、尾日无晚餐");
  assert.equal(result.savedHotels, 0, "无酒店产品 savedHotels 应为 0");
  assert.equal(result.pickupAirport, "LJG");
  assert.equal(result.pickupTrain, "CN001LHM");
  // 正常存为草稿只调用一次 check(saveType=2)，不得回退到 8/3。
  const checkCalls = callLog.filter((c) => c.endpoint === "/restapi/soa2/15638/checkTourDaily");
  assert.equal(checkCalls.length, 1);
  assert.equal((checkCalls[0].body as any).saveType, 2);
  const initialTourDaily = JSON.parse((checkCalls[0].body as any).tourDaily);
  assert.equal(initialTourDaily.isModify, true, "已采样草稿协议要求显式标记行程修改");
  const firstPoi = initialTourDaily.tourDailyDescriptions[0].tourDailyInfos
    .find((info: any) => info.activeType?.key === 3).tourDailyPois[0];
  assert.equal(firstPoi.poi.poiType.key, 3, "suggestPoi 的景点类型必须写入最终保存 payload");
  assert.equal(firstPoi.poi.ticketType.key, 1, "suggestPoi 的门票类型不能被清洗器丢失");
  assert.deepEqual(firstPoi.suffixName, { key: 13, name: "含成人儿童首道门票" });
  const association = callLog.find((c) => c.endpoint === "/restapi/soa2/15638/saveProductTourInfo");
  assert.equal((association?.body as any).tourInfo.productId, 77035928);
  assert.equal((association?.body as any).saveType, 2);
  assert.equal((association?.body as any).tourInfo.tourInfoId, "409136029189275700");
  assert.equal((association?.body as any).tourInfo.draftTourInfoId, "417899634191761447");
  assert.equal((association?.body as any).tourInfo.auditTourInfoId, "409136029189275700");
  assert.equal((association?.body as any).tourInfo.auditTourInfoStatus, 2);
  assert.equal(JSON.parse((association?.body as any).tourDaily).tourInfoId, "417899634191761447");
  const detailSave = callLog.find((c) => c.endpoint === "/restapi/soa2/20049/saveTourDailyDetail.json");
  assert.equal((detailSave?.body as any).saveType, 2);
  assert.equal((detailSave?.body as any).tourInfo.tourInfoId, "417899634191761447");
  assert.equal(result.tourInfoId, "417899634191761447");
});

test("ensureItineraryApi：check(2) 响应缺 tourDaily → 立即失败", async () => {
  const handlers = makeHandlers();
  handlers["/restapi/soa2/15638/checkTourDaily"] = () => ({
    ResponseStatus: { Ack: "Success", Errors: [] },
  });
  Object.assign(routeHandlers, handlers);
  await assert.rejects(
    () => ensureItineraryApi(makeFakePage() as any, baseProduct as any, "77035928"),
    /响应缺 tourDaily 字段/,
  );
});

test("ensureItineraryApi：check(2) 回写不同集合机场时不发送详情或关联保存", async () => {
  const handlers = makeHandlers();
  const normalCheck = handlers["/restapi/soa2/15638/checkTourDaily"]!;
  handlers["/restapi/soa2/15638/checkTourDaily"] = (body) => {
    const payload = normalCheck(body);
    const daily = JSON.parse(payload.tourDaily);
    const gather = daily.tourDailyDescriptions[0].tourDailyInfos.find((info: any) => info.activeType?.key === 25);
    gather.tourDailyPackageGatherList[0].airports = [{ code: "XMN", name: "高崎国际机场" }];
    return { ...payload, tourDaily: JSON.stringify(daily) };
  };
  Object.assign(routeHandlers, handlers);
  await assert.rejects(
    () => ensureItineraryApi(makeFakePage() as any, baseProduct as any, "77035928"),
    /校验响应改写白名单字段/,
  );
  assert.equal(callLog.some((call) => /saveTourDailyDetail|saveProductTourInfo/.test(call.endpoint)), false);
});

test("ensureItineraryApi：check 可剥离酒店 grade，但保留候选和酒店说明中的客户钻级", async () => {
  const hotelRichProduct = structuredClone(baseProduct) as any;
  hotelRichProduct.itinerary = Array.from({ length: 5 }, (_, index) => {
    const day = index + 1;
    const hotel = `酒店${day}`;
    const spot = index === 0
      ? { name: `景点${day}`, poiName: "Old Town of Lijiang", poiId: 75924 }
      : { name: `景点${day}`, poiName: "Jade Dragon Snow Mountain", poiId: 10543884 };
    return {
      day, title: `第${day}天`, spots: [spot],
      description: "自由活动", hotel, meals: "自理",
      ...(day <= 3 ? { hotelCandidates: [1, 2, 3].map((candidate) => ({ hotelName: `${hotel}-候选${candidate}` })) } : {}),
    };
  });
  const handlers = makeHandlers({ readbackOverrides: {
    readbackDays: 5,
    title: (index) => `第${index + 1}天`,
    hotelName: () => "使用携程平台酒店，自动匹配三钻、四钻、五钻酒店",
  } });
  const normalCheck = handlers["/restapi/soa2/15638/checkTourDaily"]!;
  handlers["/restapi/soa2/15638/checkTourDaily"] = (body) => {
    const payload = normalCheck(body);
    const daily = JSON.parse(payload.tourDaily);
    for (const day of daily.tourDailyDescriptions) {
      for (const info of day.tourDailyInfos) {
        if (info.activeType?.key !== 1) continue;
        for (const slot of info.tourDailyHotels) delete slot.hotel.grade;
      }
    }
    return { ...payload, tourDaily: JSON.stringify(daily) };
  };
  Object.assign(routeHandlers, handlers);
  await ensureItineraryApi(makeFakePage() as any, hotelRichProduct, "77035928");
  const check = callLog.find((call) => /checkTourDaily/.test(call.endpoint));
  const checkedHotels = JSON.parse((check?.body as any).tourDaily).tourDailyDescriptions
    .map((day: any) => day.tourDailyInfos.find((info: any) => info.activeType?.key === 1).tourDailyHotels.length);
  assert.deepEqual(checkedHotels, [1, 1, 1, 1, 1], "历史候选全部转换为统一平台自动匹配节点");
  assert.equal(callLog.some((call) => /saveTourDailyDetail/.test(call.endpoint)), true);
  assert.equal(callLog.some((call) => /saveProductTourInfo/.test(call.endpoint)), true);
});

test("ensureItineraryApi：check 改写酒店候选或移除客户钻级说明时不发送保存", async () => {
  const handlers = makeHandlers();
  const normalCheck = handlers["/restapi/soa2/15638/checkTourDaily"]!;
  handlers["/restapi/soa2/15638/checkTourDaily"] = (body) => {
    const payload = normalCheck(body);
    const daily = JSON.parse(payload.tourDaily);
    const hotel = daily.tourDailyDescriptions[0].tourDailyInfos.find((info: any) => info.activeType?.key === 1);
    hotel.tourDailyHotels[0].hotel.hotelName = "被改写的酒店";
    hotel.description = "被改写的酒店";
    delete hotel.tourDailyHotels[0].hotel.grade;
    return { ...payload, tourDaily: JSON.stringify(daily) };
  };
  Object.assign(routeHandlers, handlers);
  await assert.rejects(
    () => ensureItineraryApi(makeFakePage() as any, baseProduct as any, "77035928"),
    /校验响应改写白名单字段/,
  );
  assert.equal(callLog.some((call) => /saveTourDailyDetail|saveProductTourInfo/.test(call.endpoint)), false);
});
