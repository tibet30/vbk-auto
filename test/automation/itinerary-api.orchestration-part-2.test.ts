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

test.before(() => installFetchStub());
test.after(() => uninstallFetchStub());
test.beforeEach(() => { clearRouteHandlers(); resetCallLog(); });

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

test("关联列表含未知空版本时不猜测模板或旧 8→3 协议", async () => {
  Object.assign(routeHandlers, makeHandlers({ emptyProduct: true }));
  routeHandlers["/restapi/soa2/15638/getProductTourInfoList"] = () => ({
    ResponseStatus: { Ack: "Success", Errors: [] },
    templateId: 3,
    tourInfos: [{ tourInfoId: 0 }],
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
