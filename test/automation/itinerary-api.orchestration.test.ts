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
    hotelName: (index) => index < 3 ? `酒店${index + 1}-候选1` : `酒店${index + 1}`,
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
  assert.deepEqual(checkedHotels, [3, 3, 3, 1, 1], "十一家候选按每晚分布保留");
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

test("ensureItineraryApi：check(2) 回读的 draft ID 漂移时不发送保存请求", async () => {
  const handlers = makeHandlers();
  handlers["/restapi/soa2/15638/checkTourDaily"] = (body) => ({
    ResponseStatus: { Ack: "Success", Errors: [] },
    tourDaily: JSON.stringify({ ...JSON.parse(body.tourDaily), tourInfoId: "417815590194610232" }),
  });
  Object.assign(routeHandlers, handlers);
  await assert.rejects(
    () => ensureItineraryApi(makeFakePage() as any, baseProduct as any, "77035928"),
    /草稿校验未回读 draftTourInfoId/,
  );
  assert.equal(callLog.some((call) => /saveTourDailyDetail|saveProductTourInfo/.test(call.endpoint)), false);
});

test("ensureItineraryApi：saveTourDailyDetail Ack=Success 但响应缺 tourInfo → 立即失败", async () => {
  const handlers = makeHandlers();
  handlers["/restapi/soa2/20049/saveTourDailyDetail.json"] = () => ({
    ResponseStatus: { Ack: "Success", Errors: [] },
  });
  Object.assign(routeHandlers, handlers);
  await assert.rejects(
    () => ensureItineraryApi(makeFakePage() as any, baseProduct as any, "77035928"),
    /响应缺 tourInfo/,
  );
});

test("ensureItineraryApi：接送站返回 0 候选 → 失败", async () => {
  const handlers = makeHandlers();
  handlers["/restapi/soa2/20049/suggestAirport"] = () => ({
    ResponseStatus: { Ack: "Success", Errors: [] },
    airports: [],
  });
  handlers["/restapi/soa2/20049/suggestTrainStation"] = () => ({
    ResponseStatus: { Ack: "Success", Errors: [] },
    trainStations: [],
  });
  Object.assign(routeHandlers, handlers);
  const noVerifiedEndpointProduct = structuredClone(baseProduct) as any;
  delete noVerifiedEndpointProduct.operations.trafficLine;
  await assert.rejects(
    () => ensureItineraryApi(makeFakePage() as any, noVerifiedEndpointProduct, "77035928"),
    /无任何可用机场\/火车站候选/,
  );
});

test("ensureItineraryApi：poiId 缺失 → 在 transform 阶段失败", async () => {
  Object.assign(routeHandlers, makeHandlers());
  const badProduct = {
    ...baseProduct,
    itinerary: [
      { day: 1, title: "第1天", spots: [{ name: "未命名", poiName: null, poiId: null }], description: "X", hotel: "", meals: "自理" },
    ],
  };
  await assert.rejects(
    () => ensureItineraryApi(makeFakePage() as any, badProduct as any, "77035928"),
    /缺 poiId\/poiName/,
  );
});

test("ensureItineraryApi：回读 day 数不一致 → 失败", async () => {
  Object.assign(routeHandlers, makeHandlers({ readbackDays: 1 }));
  await assert.rejects(
    () => ensureItineraryApi(makeFakePage() as any, baseProduct as any, "77035928"),
    /回读行程天数不一致/,
  );
});

test("ensureItineraryApi：成功才返回，绝不在缺字段时返回部分结果", async () => {
  installHandlersForFieldMismatch({ hotelName: () => "", otherDescription: () => "自由活动", serviceStart: "08:00", serviceEnd: "20:00", title: (i) => i === 0 ? "第1天" : "第2天" });
  const result = await ensureItineraryApi(makeFakePage() as any, baseProductNoHotel as any, "77035928");
  for (const key of [
    "productId",
    "tourInfoId",
    "auditTourInfoId",
    "days",
    "savedSpots",
    "savedMeals",
    "savedHotels",
    "pickupAirport",
    "pickupTrain",
    "dropoffAirport",
    "dropoffTrain",
  ]) {
    assert.ok(key in result, `结果必须含 ${key}`);
  }
  assert.notEqual(result.tourInfoId, 0);
});

// ───────── 修复点 1：draftTourInfoId / 非空产品 → initialText 必须是完整 newTourInfo ─────────

test("草稿关联中 draft 与 formal 同 ID 时 fail closed，且不发送 check/save", async () => {
  installHandlersForFieldMismatch({ hotelName: () => "", otherDescription: () => "自由活动", serviceStart: "08:00", serviceEnd: "20:00", title: (i) => i === 0 ? "第1天" : "第2天" });
  // draft 不能复用 formal 身份，否则不能作为未提交草稿目标。
  routeHandlers["/restapi/soa2/15638/getProductTourInfoList"] = () => ({
    ResponseStatus: { Ack: "Success", Errors: [] },
    tourInfos: [{
      tourInfoId: "409136029189275700",
      draftTourInfoId: "409136029189275700",
      productId: 77035928,
      main: true,
      sort: 0,
      templateId: 3,
    }],
  });
  await assert.rejects(
    () => ensureItineraryApi(makeFakePage() as any, baseProductNoHotel as any, "77035928"),
    /未返回独立的 draftTourInfoId/,
  );
  assert.equal(callLog.some((call) => /checkTourDaily|saveTourDailyDetail|saveProductTourInfo/.test(call.endpoint)), false);
});

test("草稿主路径不调用 legacy check(8/3) 或评分接口", async () => {
  installHandlersForFieldMismatch({ hotelName: () => "", otherDescription: () => "自由活动", serviceStart: "08:00", serviceEnd: "20:00", title: (i) => i === 0 ? "第1天" : "第2天" });
  await ensureItineraryApi(makeFakePage() as any, baseProductNoHotel as any, "77035928");
  const checkCalls = callLog.filter((c) => c.endpoint === "/restapi/soa2/15638/checkTourDaily");
  assert.equal(checkCalls.length, 1);
  assert.equal((checkCalls[0].body as any).saveType, 2);
  assert.equal(callLog.some((call) => call.endpoint.includes("calculateTourInfoScore")), false);
});

// ───────── 首建缺少真实协议证据时 fail closed ─────────

test("首建关联列表为空时不猜测模板或旧 8→3 协议", async () => {
  Object.assign(routeHandlers, makeHandlers({ emptyProduct: true }));
  routeHandlers["/restapi/soa2/15638/getProductTourInfoList"] = () => ({
    ResponseStatus: { Ack: "Success", Errors: [] },
    templateId: 3,
    tourInfos: [],
  });
  await assert.rejects(
    () => ensureItineraryApi(makeFakePage() as any, baseProductNoHotel as any, "77035928"),
    /未返回独立的 draftTourInfoId/,
  );
  assert.equal(callLog.some((call) => call.endpoint.includes("getDailyTemplateDetail")), false);
  assert.equal(callLog.some((call) => /checkTourDaily|saveTourDailyDetail|saveProductTourInfo/.test(call.endpoint)), false);
});

test("首建未提交产品只有 previewTourInfoId 时使用 preview 作为独立草稿目标", async () => {
  installHandlersForFieldMismatch({
    hotelName: () => "",
    otherDescription: () => "自由活动",
    serviceStart: "08:00",
    serviceEnd: "20:00",
    title: (i) => i === 0 ? "第1天" : "第2天",
  });
  const previewTourInfoId = "418000911988932725";
  const checkedTourInfoId = "418082233558728760";
  let listCalls = 0;
  routeHandlers["/restapi/soa2/15638/getProductTourInfoList"] = () => {
    listCalls += 1;
    return {
      ResponseStatus: { Ack: "Success", Errors: [] },
      tourInfos: [{
        tourInfoId: 0,
        ...(listCalls > 1 ? { draftTourInfoId: checkedTourInfoId, draftTourInfoStatus: 1 } : {}),
        previewTourInfoId,
        auditStatus: { key: "N", value: "未提交" },
        productId: 77035928,
        main: true,
        sort: 0,
        templateId: 3,
      }],
    };
  };
  routeHandlers["/restapi/soa2/15638/checkTourDaily"] = (body: any) => ({
    ResponseStatus: { Ack: "Success", Errors: [] },
    tourDaily: JSON.stringify({ ...JSON.parse(body.tourDaily), tourInfoId: checkedTourInfoId }),
  });
  routeHandlers["/restapi/soa2/20049/saveTourDailyDetail.json"] = () => ({
    ResponseStatus: { Ack: "Success", Errors: [] },
    tourInfoId: checkedTourInfoId,
  });

  const result = await ensureItineraryApi(makeFakePage() as any, baseProductNoHotel as any, "77035928");

  assert.equal(listCalls, 2);
  assert.equal(result.tourInfoId, checkedTourInfoId);
  const check = callLog.find((call) => call.endpoint === "/restapi/soa2/15638/checkTourDaily");
  assert.equal(JSON.parse((check?.body as any).tourDaily).tourInfoId, previewTourInfoId);
  const detailSave = callLog.find((call) => call.endpoint === "/restapi/soa2/20049/saveTourDailyDetail.json");
  assert.equal((detailSave?.body as any).tourInfo.tourInfoId, checkedTourInfoId);
  const association = callLog.find((call) => call.endpoint === "/restapi/soa2/15638/saveProductTourInfo");
  assert.equal((association?.body as any).tourInfo.tourInfoId, checkedTourInfoId);
  assert.equal((association?.body as any).tourInfo.auditTourInfoId, checkedTourInfoId);
  assert.equal(JSON.parse((association?.body as any).tourDaily).tourInfoId, checkedTourInfoId);
});

test("首建 preview 保存后若平台把新草稿放入 tourInfoId，也使用该 ID 回读", async () => {
  installHandlersForFieldMismatch({
    hotelName: () => "",
    otherDescription: () => "自由活动",
    serviceStart: "08:00",
    serviceEnd: "20:00",
    title: (i) => i === 0 ? "第1天" : "第2天",
  });
  const previewTourInfoId = "418000911988932725";
  const checkedTourInfoId = "418082233558728760";
  let listCalls = 0;
  routeHandlers["/restapi/soa2/15638/getProductTourInfoList"] = () => {
    listCalls += 1;
    return {
      ResponseStatus: { Ack: "Success", Errors: [] },
      tourInfos: [{
        tourInfoId: listCalls > 1 ? checkedTourInfoId : 0,
        ...(listCalls > 1 ? { auditTourInfoId: checkedTourInfoId, auditTourInfoStatus: 1 } : {}),
        previewTourInfoId,
        auditStatus: { key: "N", value: "未提交" },
        productId: 77035928,
        main: true,
        sort: 0,
        templateId: 3,
      }],
    };
  };
  routeHandlers["/restapi/soa2/15638/checkTourDaily"] = (body: any) => ({
    ResponseStatus: { Ack: "Success", Errors: [] },
    tourDaily: JSON.stringify({ ...JSON.parse(body.tourDaily), tourInfoId: checkedTourInfoId }),
  });
  routeHandlers["/restapi/soa2/20049/saveTourDailyDetail.json"] = () => ({
    ResponseStatus: { Ack: "Success", Errors: [] },
    tourInfoId: checkedTourInfoId,
  });

  const result = await ensureItineraryApi(makeFakePage() as any, baseProductNoHotel as any, "77035928");

  assert.equal(listCalls, 2);
  assert.equal(result.tourInfoId, checkedTourInfoId);
});

test("未提交产品 tourInfoId 与 auditTourInfoId 相同时可继续作为当前草稿目标", async () => {
  installHandlersForFieldMismatch({
    hotelName: () => "",
    otherDescription: () => "自由活动",
    serviceStart: "08:00",
    serviceEnd: "20:00",
    title: (i) => i === 0 ? "第1天" : "第2天",
  });
  const currentTourInfoId = "418082233558728766";
  routeHandlers["/restapi/soa2/15638/getProductTourInfoList"] = () => ({
    ResponseStatus: { Ack: "Success", Errors: [] },
    tourInfos: [{
      tourInfoId: currentTourInfoId,
      auditTourInfoId: currentTourInfoId,
      auditTourInfoStatus: 1,
      previewTourInfoId: "418000911988932725",
      auditStatus: { key: "N", value: "未提交" },
      productId: 77035928,
      main: true,
      sort: 0,
      templateId: 3,
    }],
  });
  routeHandlers["/restapi/soa2/15638/checkTourDaily"] = (body: any) => ({
    ResponseStatus: { Ack: "Success", Errors: [] },
    tourDaily: JSON.stringify({ ...JSON.parse(body.tourDaily), tourInfoId: currentTourInfoId }),
  });
  routeHandlers["/restapi/soa2/20049/saveTourDailyDetail.json"] = () => ({
    ResponseStatus: { Ack: "Success", Errors: [] },
    tourInfoId: currentTourInfoId,
  });

  const result = await ensureItineraryApi(makeFakePage() as any, baseProductNoHotel as any, "77035928");

  assert.equal(result.tourInfoId, currentTourInfoId);
  const association = callLog.find((call) => call.endpoint === "/restapi/soa2/15638/saveProductTourInfo");
  assert.equal((association?.body as any).tourInfo.tourInfoId, currentTourInfoId);
});

test("未提交 current version 的 check 若生成新 ID，后续保存和关联跟随新 ID", async () => {
  installHandlersForFieldMismatch({
    hotelName: () => "",
    otherDescription: () => "自由活动",
    serviceStart: "08:00",
    serviceEnd: "20:00",
    title: (i) => i === 0 ? "第1天" : "第2天",
  });
  const currentTourInfoId = "418082233558728766";
  const checkedTourInfoId = "418082111915507838";
  let listCalls = 0;
  routeHandlers["/restapi/soa2/15638/getProductTourInfoList"] = () => {
    listCalls += 1;
    const id = listCalls > 1 ? checkedTourInfoId : currentTourInfoId;
    return {
      ResponseStatus: { Ack: "Success", Errors: [] },
      tourInfos: [{
        tourInfoId: id,
        auditTourInfoId: id,
        auditTourInfoStatus: 1,
        previewTourInfoId: "418000911988932725",
        auditStatus: { key: "N", value: "未提交" },
        productId: 77035928,
        main: true,
        sort: 0,
        templateId: 3,
      }],
    };
  };
  routeHandlers["/restapi/soa2/15638/checkTourDaily"] = (body: any) => ({
    ResponseStatus: { Ack: "Success", Errors: [] },
    tourDaily: JSON.stringify({ ...JSON.parse(body.tourDaily), tourInfoId: checkedTourInfoId }),
  });
  routeHandlers["/restapi/soa2/20049/saveTourDailyDetail.json"] = () => ({
    ResponseStatus: { Ack: "Success", Errors: [] },
    tourInfoId: checkedTourInfoId,
  });

  const result = await ensureItineraryApi(makeFakePage() as any, baseProductNoHotel as any, "77035928");

  assert.equal(result.tourInfoId, checkedTourInfoId);
  const association = callLog.find((call) => call.endpoint === "/restapi/soa2/15638/saveProductTourInfo");
  assert.equal((association?.body as any).tourInfo.tourInfoId, checkedTourInfoId);
  assert.equal(JSON.parse((association?.body as any).tourDaily).tourInfoId, checkedTourInfoId);
});

// ───────── 修复点 3：saveTourDailyDetail 响应仅含顶层 tourInfoId → 必须接受 ─────────

test("修复：saveTourDailyDetail 响应仅含顶层 tourInfoId（无 tourInfo / result）→ 接受", async () => {
  installHandlersForFieldMismatch({ hotelName: () => "", otherDescription: () => "自由活动", serviceStart: "08:00", serviceEnd: "20:00", title: (i) => i === 0 ? "第1天" : "第2天" });
  // 让 saveTourDailyDetail 只回顶层 tourInfoId，不带 tourInfo / result
  routeHandlers["/restapi/soa2/20049/saveTourDailyDetail.json"] = () => ({
    ResponseStatus: { Ack: "Success", Errors: [] },
    tourInfoId: "417899634191761447",
  });
  const result = await ensureItineraryApi(makeFakePage() as any, baseProductNoHotel as any, "77035928");
  assert.equal(result.tourInfoId, "417899634191761447", "最终回读目标必须是关联的 draft ID");
  assert.equal(result.auditTourInfoId, "409136029189275700", "历史 audit ID 必须保留");
  assert.equal(result.days, 2);
});

test("修复：saveTourDailyDetail 响应完全空（无 tourInfo / result / tourInfoId）→ 必须失败", async () => {
  installHandlersForFieldMismatch({ hotelName: () => "", otherDescription: () => "自由活动", serviceStart: "08:00", serviceEnd: "20:00", title: (i) => i === 0 ? "第1天" : "第2天" });
  // 三个字段全空 → 仍必须抛错（防后端悄悄吃掉请求）
  routeHandlers["/restapi/soa2/20049/saveTourDailyDetail.json"] = () => ({
    ResponseStatus: { Ack: "Success", Errors: [] },
  });
  await assert.rejects(
    () => ensureItineraryApi(makeFakePage() as any, baseProductNoHotel as any, "77035928"),
    /响应缺 tourInfo/,
  );
});

test("草稿关联保存后 formal/audit/preview 或审核状态漂移时拒绝最终回读", async () => {
  const handlers = makeHandlers();
  const list = handlers["/restapi/soa2/15638/getProductTourInfoList"];
  let listCalls = 0;
  handlers["/restapi/soa2/15638/getProductTourInfoList"] = (body) => {
    const payload = list(body);
    listCalls += 1;
    if (listCalls === 2) (payload.tourInfos[0] as any).auditStatus = { key: "N", value: "未提交" };
    return payload;
  };
  Object.assign(routeHandlers, handlers);
  await assert.rejects(
    () => ensureItineraryApi(makeFakePage() as any, baseProduct as any, "77035928"),
    /auditStatus 发生未授权变化/,
  );
});

test("本地未填票型时以 suggestPoi 的免费票型生成并回读无需门票", async () => {
  const handlers = makeHandlers({ readbackOverrides: { hotelName: () => "" } });
  handlers["/restapi/soa2/20049/suggestPoi"] = (body: any) => ({
    ResponseStatus: { Ack: "Success", Errors: [] },
    poiList: [{
      poiId: body.keyword === "Jade Dragon Snow Mountain" ? 10543884 : 75924,
      poiName: body.keyword,
      poiType: { key: 3, name: "景点" },
      ticketType: { key: 2, name: "免费" },
    }],
  });
  const readDetail = handlers["/restapi/soa2/20049/getTourDailyDetail.json"];
  handlers["/restapi/soa2/20049/getTourDailyDetail.json"] = (body: any) => {
    const payload = readDetail(body);
    for (const day of payload.tourInfo.tourDailyDescriptions) {
      for (const info of day.tourDailyInfos) {
        for (const poi of info.tourDailyPois ?? []) poi.suffixName = { key: 11, name: "无需门票" };
      }
    }
    return payload;
  };
  Object.assign(routeHandlers, handlers);
  await ensureItineraryApi(makeFakePage() as any, baseProductNoHotel as any, "77035928");
  const check = callLog.find((call) => call.endpoint === "/restapi/soa2/15638/checkTourDaily");
  const saved = JSON.parse((check?.body as any).tourDaily);
  const attraction = saved.tourDailyDescriptions[0].tourDailyInfos.find((info: any) => info.activeType?.key === 3);
  assert.deepEqual(attraction.tourDailyPois[0].suffixName, { key: 11, name: "无需门票" });
});
