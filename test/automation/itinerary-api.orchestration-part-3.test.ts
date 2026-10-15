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

test("未提交 current version 的 check 若生成新 ID，详情与 tourDaily 跟随新 ID，正式/审核身份不动", async () => {
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
    return {
      ResponseStatus: { Ack: "Success", Errors: [] },
      tourInfos: [{
        tourInfoId: currentTourInfoId,
        auditTourInfoId: currentTourInfoId,
        auditTourInfoStatus: 1,
        ...(listCalls > 1 ? { draftTourInfoId: checkedTourInfoId, draftTourInfoStatus: 1 } : {}),
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
  assert.equal((association?.body as any).tourInfo.tourInfoId, currentTourInfoId, "正式身份保持既有版本");
  assert.equal((association?.body as any).tourInfo.auditTourInfoId, currentTourInfoId, "审核指针保持既有版本");
  assert.equal((association?.body as any).tourInfo.draftTourInfoId, checkedTourInfoId);
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
