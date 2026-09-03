// itinerary-api 的"编排 + 单接口步骤"契约：
//   - pickAirport / pickTrain 候选排序；
//   - countItineraryApiSpots 兼容统计；
//   - ensureItineraryApi 主路径按 6 步顺序调用（suggestAirport/suggestTrainStation
//     → getProductTourInfoList → getTourDailyDetail → checkTourDaily(8) →
//     calculateTourInfoScore → checkTourDaily(3) → saveTourDailyDetail →
//     saveProductTourInfo → getTourDailyDetail 回读校验）；
//   - 失败契约：check(8) 响应缺 tourDaily、saveTourDailyDetail 响应缺 tourInfo、
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

test("pickAirport：0 个候选返回 null；1 个返回该候选；多候选按精确 > 国际 > 城市机场 > 首项", () => {
  assert.equal(pickAirport([], "丽江"), null);
  const one = pickAirport([makeCandidate("air", "LJG", "三义机场")], "丽江");
  assert.ok(one && one.code === "LJG");
  const exact = pickAirport([
    makeCandidate("air", "PVG", "浦东国际机场"),
    makeCandidate("air", "SHA", "上海"),
  ], "上海");
  assert.equal(exact?.code, "SHA", "精确同名 city=上海 必须命中");
  const primary = pickAirport([
    makeCandidate("air", "WUX", "苏南硕放国际机场"),
    makeCandidate("air", "SHA", "上海"),
  ], "苏州");
  assert.equal(primary?.code, "WUX", "苏州无精确匹配，落到国际机场");
  const fallback = pickAirport([
    makeCandidate("air", "FOO", "城市机场"),
    makeCandidate("air", "BAR", "BAR"),
  ], "未知");
  assert.equal(fallback?.code, "FOO", "都未匹配时取首项");
});

test("pickTrain：0 个候选返回 null；1 个返回该候选；多候选精确同名优先，否则首项", () => {
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
  assert.equal(fallback?.code, "CN001XXX");
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

test("ensureItineraryApi 主路径按 getTourInfo → detail → check(8) → score → check(3) → save → 回读 调用", async () => {
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
    "/restapi/soa2/20049/calculateTourInfoScore",
    "/restapi/soa2/15638/checkTourDaily",
    "/restapi/soa2/20049/saveTourDailyDetail.json",
    "/restapi/soa2/15638/saveProductTourInfo",
    "/restapi/soa2/20049/getTourDailyDetail.json",
  ];
  assert.deepEqual(sequence, expect, `实际顺序: ${sequence.join(", ")}`);
  assert.equal(result.days, 2);
  assert.equal(result.savedSpots, 2);
  assert.equal(result.savedMeals, 4, "首日无早餐、尾日无晚餐");
  assert.equal(result.savedHotels, 0, "无酒店产品 savedHotels 应为 0");
  assert.equal(result.pickupAirport, "LJG");
  assert.equal(result.pickupTrain, "CN001LHM");
  // checkTourDaily 必须 saveType=8 和 3 各一次
  const checkCalls = callLog.filter((c) => c.endpoint === "/restapi/soa2/15638/checkTourDaily");
  assert.equal(checkCalls.length, 2);
  assert.equal((checkCalls[0].body as any).saveType, 8);
  assert.equal((checkCalls[1].body as any).saveType, 3);
  const initialTourDaily = JSON.parse((checkCalls[0].body as any).tourDaily);
  const firstPoi = initialTourDaily.tourDailyDescriptions[0].tourDailyInfos
    .find((info: any) => info.activeType?.key === 3).tourDailyPois[0];
  assert.equal(firstPoi.poi.poiType.key, 3, "suggestPoi 的景点类型必须写入最终保存 payload");
  assert.equal(firstPoi.poi.ticketType.key, 1, "suggestPoi 的门票类型不能被清洗器丢失");
  assert.deepEqual(firstPoi.suffixName, { key: 7, name: "不含门票" });
  const association = callLog.find((c) => c.endpoint === "/restapi/soa2/15638/saveProductTourInfo");
  assert.equal((association?.body as any).tourInfo.productId, 77035928);
  assert.equal((association?.body as any).tourInfo.auditTourInfoId, "999999999999999999");
});

test("ensureItineraryApi：check(8) 响应缺 tourDaily → 立即失败", async () => {
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
  await assert.rejects(
    () => ensureItineraryApi(makeFakePage() as any, baseProduct as any, "77035928"),
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

test("修复：check(8) tourDaily 必须是完整 newTourInfo（保留 draftTourInfoId + days + tourDailyDescriptions）", async () => {
  installHandlersForFieldMismatch({ hotelName: () => "", otherDescription: () => "自由活动", serviceStart: "08:00", serviceEnd: "20:00", title: (i) => i === 0 ? "第1天" : "第2天" });
  // 模拟只有 draftTourInfoId 的真实草稿场景。
  routeHandlers["/restapi/soa2/15638/getProductTourInfoList"] = () => ({
    ResponseStatus: { Ack: "Success", Errors: [] },
    tourInfos: [{
      draftTourInfoId: "409136029189275700",
      productId: 77035928,
      main: true,
      sort: 0,
      templateId: 3,
    }],
  });
  // 首次 detail 携带草稿元数据，后续调用返回保存后的回读数据。
  routeHandlers["/restapi/soa2/20049/getTourDailyDetail.json"] = (() => {
    let callIdx = 0;
    return () => {
      callIdx += 1;
      if (callIdx === 1) {
        return {
          ResponseStatus: { Ack: "Success", Errors: [] },
          tourInfo: {
            tourInfoId: "409136029189275700",
            draftTourInfoId: "409136029189275700",
            days: 2,
            tourDailyDescriptions: [],
          },
        };
      }
      // readback 阶段（save 后 verify）— 走默认 2 天 fixture
      const days = makeReadbackDays({ title: (i) => (i === 0 ? "第1天" : "第2天"), hotelName: () => "", otherDescription: () => "自由活动", serviceStart: "08:00", serviceEnd: "20:00" });
      return {
        ResponseStatus: { Ack: "Success", Errors: [] },
        tourInfo: { tourInfoId: "999999999999999999", tourDailyDescriptions: days },
      };
    };
  })();
  await ensureItineraryApi(makeFakePage() as any, baseProductNoHotel as any, "77035928");
  const checkCalls = callLog.filter((c) => c.endpoint === "/restapi/soa2/15638/checkTourDaily");
  assert.equal(checkCalls.length, 2, "checkTourDaily 必须调用 2 次");
  const initialBody = checkCalls[0].body as any;
  // initialText 必须是字符串（newTourInfo 被 JSON.stringify 过）
  assert.equal(typeof initialBody.tourDaily, "string", "initialText 必须是字符串");
  // 解析后必须含完整 newTourInfo 字段（不再是裸 { tourDailyDescriptions }）
  const initialParsed = JSON.parse(initialBody.tourDaily);
  assert.ok("tourDailyDescriptions" in initialParsed, "必须包含 tourDailyDescriptions");
  assert.ok("days" in initialParsed, "必须包含 days（修复前会丢）");
  assert.ok("tourInfoId" in initialParsed, "必须包含 tourInfoId");
  assert.ok("productId" in initialParsed, "必须包含 productId");
  assert.ok("draftTourInfoId" in initialParsed, "detail 自带 draftTourInfoId 必须写入 initialText");
  assert.equal(initialParsed.tourInfoId, "409136029189275700", "tourInfoId 必须等于 draftTourInfoId");
  assert.equal(initialParsed.draftTourInfoId, "409136029189275700");
  assert.equal(initialParsed.days, 2, "days 必须等于行程天数");
  assert.equal(initialParsed.productId, 77035928);
  // 不能退化成裸对象
  const keys = Object.keys(initialParsed);
  assert.ok(keys.length >= 6, `newTourInfo 必须含 ≥6 个字段（含 draftTourInfoId），实际=${keys.length}（${keys.join(",")}）`);
});

test("修复：check(3) tourDaily 也保留完整 newTourInfo（aggregateScore/tourInfoScores 不丢）", async () => {
  installHandlersForFieldMismatch({ hotelName: () => "", otherDescription: () => "自由活动", serviceStart: "08:00", serviceEnd: "20:00", title: (i) => i === 0 ? "第1天" : "第2天" });
  await ensureItineraryApi(makeFakePage() as any, baseProductNoHotel as any, "77035928");
  const checkCalls = callLog.filter((c) => c.endpoint === "/restapi/soa2/15638/checkTourDaily");
  const second = checkCalls[1].body as any;
  assert.equal(typeof second.tourDaily, "string");
  const parsed = JSON.parse(second.tourDaily);
  assert.equal(parsed.tourInfoId, "999999999999999999", "check(3) tourDaily 必须包含新 tourInfoId");
  assert.ok(Array.isArray(parsed.tourDailyDescriptions), "check(3) 必须保留 tourDailyDescriptions");
});

// ───────── 修复点 2：空产品 → getDailyTemplateDetail + template/templateId 写入 productTourInfo ─────────

test("修复：空产品走 getDailyTemplateDetail → template/templateId 写入 productTourInfo 和初始 tourDaily", async () => {
  // 空产品：getProductTourInfoList 返回空 tourInfos + 根级 templateId
  // readback 阶段需 hotelName 为空以匹配 baseProductNoHotel
  Object.assign(
    routeHandlers,
    makeHandlers({
      emptyProduct: true,
      templateOverride: {
        templateId: 3,
        days: 2,
        tourDailyDescriptions: [],
        templateName: "标准跟团游模板",
      },
      readbackOverrides: { hotelName: () => "" },
    }),
  );
  // 注入根级 templateId（与默认一致）
  routeHandlers["/restapi/soa2/15638/getProductTourInfoList"] = () => ({
    ResponseStatus: { Ack: "Success", Errors: [] },
    templateId: 3,
    tourInfos: [],
  });
  // 回读返回 2 天，readback 阶段需要 readback payload（save 之后 verify 仍走 getTourDailyDetail）
  const result = await ensureItineraryApi(makeFakePage() as any, baseProductNoHotel as any, "77035928");
  // 序列必须新增 getDailyTemplateDetail
  const sequence = callLog.map((c) => c.endpoint);
  assert.ok(
    sequence.includes("/restapi/soa2/20049/getDailyTemplateDetail"),
    `空产品必须调用 getDailyTemplateDetail，实际顺序=${sequence.join(",")}`,
  );
  // getDailyTemplateDetail 请求体必须含 zh-CN / templateId / contentType
  const templateCall = callLog.find((c) => c.endpoint === "/restapi/soa2/20049/getDailyTemplateDetail");
  assert.ok(templateCall, "必须至少调用一次 getDailyTemplateDetail");
  assert.equal((templateCall!.body as any).requestHeader?.locale, "zh-CN");
  assert.equal((templateCall!.body as any).templateId, 3);
  assert.equal((templateCall!.body as any).contentType, "json");
  // productTourInfo（checkTourDaily 的 productTourInfo 入参）必须含 template + templateId
  const check8 = callLog.filter((c) => c.endpoint === "/restapi/soa2/15638/checkTourDaily")[0];
  assert.ok(check8, "checkTourDaily 必须被调用");
  assert.equal((check8!.body as any).productTourInfo.templateId, 3, "productTourInfo.templateId 必须写入");
  assert.ok(
    (check8!.body as any).productTourInfo.template && typeof (check8!.body as any).productTourInfo.template === "object",
    "productTourInfo.template 必须写入（来自 getDailyTemplateDetail）",
  );
  // initialText 解析后必须含 templateId + template + days + tourDailyDescriptions
  const initialParsed = JSON.parse((check8!.body as any).tourDaily);
  assert.equal(initialParsed.templateId, 3, "initialText 必须含 templateId");
  assert.equal(initialParsed.days, 2, "initialText 必须含 days");
  assert.ok(initialParsed.template, "initialText 必须含 template");
  assert.ok(Array.isArray(initialParsed.tourDailyDescriptions), "initialText 必须含 tourDailyDescriptions");
  // 业务结果必须正常返回
  assert.equal(result.days, 2);
  assert.equal(result.tourInfoId, "999999999999999999");
});

test("修复：空产品且 getProductTourInfoList 不带 templateId → 使用默认 templateId=3", async () => {
  Object.assign(
    routeHandlers,
    makeHandlers({
      emptyProduct: true,
      readbackOverrides: { hotelName: () => "" },
    }),
  );
  // 显式不返回 templateId（根级 / tourInfos 都没有）
  routeHandlers["/restapi/soa2/15638/getProductTourInfoList"] = () => ({
    ResponseStatus: { Ack: "Success", Errors: [] },
    tourInfos: [],
  });
  await ensureItineraryApi(makeFakePage() as any, baseProductNoHotel as any, "77035928");
  const templateCall = callLog.find((c) => c.endpoint === "/restapi/soa2/20049/getDailyTemplateDetail");
  assert.ok(templateCall);
  assert.equal((templateCall!.body as any).templateId, 3, "缺省 templateId 必须落到 3");
});

// ───────── 修复点 3：saveTourDailyDetail 响应仅含顶层 tourInfoId → 必须接受 ─────────

test("修复：saveTourDailyDetail 响应仅含顶层 tourInfoId（无 tourInfo / result）→ 接受", async () => {
  installHandlersForFieldMismatch({ hotelName: () => "", otherDescription: () => "自由活动", serviceStart: "08:00", serviceEnd: "20:00", title: (i) => i === 0 ? "第1天" : "第2天" });
  // 让 saveTourDailyDetail 只回顶层 tourInfoId，不带 tourInfo / result
  routeHandlers["/restapi/soa2/20049/saveTourDailyDetail.json"] = () => ({
    ResponseStatus: { Ack: "Success", Errors: [] },
    tourInfoId: "999999999999999999",
  });
  // 不应抛错；savedTourInfoId 仍由 check(3) 响应给出（999999999999999999）
  const result = await ensureItineraryApi(makeFakePage() as any, baseProductNoHotel as any, "77035928");
  assert.equal(result.tourInfoId, "999999999999999999", "必须从 check(3) 响应拿到 savedTourInfoId");
  assert.equal(result.auditTourInfoId, "999999999999999999");
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
