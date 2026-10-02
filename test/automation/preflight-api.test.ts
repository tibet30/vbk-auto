import assert from "node:assert/strict";
import test from "node:test";
import { runProductPreflightApi } from "../../src/main/automation/ctrip/preflight-api.ts";
import { verifyHotelResourceReadback } from "../../src/main/automation/ctrip/hotel-resource-readback.ts";
import { localBusinessDate } from "../../src/main/automation/ctrip/pricing-api.ts";
import { verifyPricingInventoryReadback } from "../../src/main/automation/ctrip/pricing-readback.ts";

const success = (payload: Record<string, unknown>) => ({
  status: 200,
  payload: { ResponseStatus: { Ack: "Success" }, ...payload },
  durationMs: 1,
  ctx: {},
});

const preflightPresentation = {
  cover: { source: "ctripLibrary", imageId: 99001 },
  recommendations: [
    { category: "服务保障", text: "专属行程服务" },
    { category: "贴心赠送", text: "出行贴心安排" },
    { category: "精选酒店", text: "舒适住宿体验" },
  ],
  features: "<p>潮州深度体验</p>",
};

const preflightBase = (productId: number) => ({
  productId,
  masterDepartureCityId: 28,
  masterDepartureCityName: "成都",
  destinationCityID: 28,
  destinationCityName: "成都",
  travelDays: 2,
  maxTravelDays: 2,
  travelNights: 1,
  vendorProductCode: `VBK-${productId}`,
});

const preflightDescription = () => ({
  info: {
    pmRcmdItems: preflightPresentation.recommendations.map((item) => ({ rcmdDesc: item.text })),
    productDesc: { productDesc: preflightPresentation.features },
  },
});

const preflightClauses = () => ({
  centralDataDto: { additionalInfoDto: { firstClassTypeIds: [] }, filterConditionDto: { productId: 1 } },
});

const preflightCover = () => ({
  productImages: [{ imageInfo: { imageId: 99001, accompanyTourInfo: { imageTypeId: 2 } } }],
});

test("母产品没有酒店或用车资源需求时，预检不读取交通子产品资源段", async () => {
  const businessDate = localBusinessDate();
  const endpoints: string[] = [];
  const page = {
    evaluate: async (_fn: unknown, request: any) => {
      const endpoint = String(request?.endpoint ?? "");
      endpoints.push(endpoint);
      if (endpoint.endsWith("/getProductBaseInfo")) {
        return success({ baseInfo: preflightBase(78490988) });
      }
      if (endpoint.endsWith("/getPackageList")) {
        return success({
          itemList: [{ name: "成都2天1晚自由行", singleResourceId: 11, optionalResourceId: 22 }],
        });
      }
      if (endpoint.endsWith("/getdescriptionInfo")) {
        return success(preflightDescription());
      }
      if (endpoint.endsWith("/getProductTourInfoList")) {
        return success({ tourInfos: [{ tourInfoId: 1001 }] });
      }
      if (endpoint.endsWith("/getTourDailyDetail.json")) {
        return success({ tourInfo: { tourDailyDescriptions: [{}, {}] } });
      }
      if (endpoint.endsWith("/listProductClauses")) return success(preflightClauses());
      if (endpoint.endsWith("/getClausePackage")) return success({ clauseTypeDtos: [] });
      if (endpoint.endsWith("/searchProductImage.json")) return success(preflightCover());
      if (endpoint.endsWith("/GetBatchOperateSchedule")) {
        return success({ dates: [{ adultPrice: { date: businessDate, cost: 100, marketPrice: 200 }, inventory: { total: 10 } }] });
      }
      if (endpoint.endsWith("/getSegments")) {
        throw new Error("不应为交通子产品失败读取母产品资源段");
      }
      throw new Error(`unexpected endpoint ${endpoint}`);
    },
  };

  const result = await runProductPreflightApi(page, {
    basicInfo: { meetingCity: "成都", destinationCity: "成都", days: 2, nights: 1 },
    presentation: preflightPresentation,
    commercial: {
      packageName: "成都2天1晚自由行",
      pricing: { minimumTravelers: 1, adult: 200, child: 100, cost: { adult: 100 } },
      inventory: { startDate: businessDate, endDate: businessDate, dailyQuota: 10 },
    },
    operations: {
      hotelResource: { source: "nonPlatform" },
      transport: "none",
      vehicleResource: {},
    },
    itinerary: [
      { day: 1, hotel: "无" },
      { day: 2, hotel: "无" },
    ],
  }, "78490988");

  assert.equal(result.verifiedWith, "remote-api-readback");
  assert.equal(result.resources.segmentCount, 0);
  assert.equal(endpoints.some((endpoint) => endpoint.endsWith("/getSegments")), false);
});

test("含酒店的预检只读取已保存资源段，不初始化或保存酒店资源", async () => {
  const endpoints: string[] = [];
  const page = {
    evaluate: async (_fn: unknown, request: any) => {
      const endpoint = String(request?.endpoint ?? "");
      endpoints.push(endpoint);
      if (endpoint.endsWith("/getProductBaseInfo")) return success({ baseInfo: preflightBase(78490989) });
      if (endpoint.endsWith("/getPackageList")) return success({ itemList: [{ name: "成都2天1晚自由行", singleResourceId: 11 }] });
      if (endpoint.endsWith("/getdescriptionInfo")) return success(preflightDescription());
      if (endpoint.endsWith("/getProductTourInfoList")) return success({ tourInfos: [{ tourInfoId: 1001 }] });
      if (endpoint.endsWith("/getTourDailyDetail.json")) return success({ tourInfo: { tourDailyDescriptions: [{}, {}] } });
      if (endpoint.endsWith("/listProductClauses")) return success(preflightClauses());
      if (endpoint.endsWith("/getClausePackage")) return success({ clauseTypeDtos: [] });
      if (endpoint.endsWith("/searchProductImage.json")) return success(preflightCover());
      if (endpoint.endsWith("/getSegments")) return success({ draftProductSegments: { segments: [
        { segmentId: 1, segmentBase: { stayNights: 0 } },
        { segmentId: 2, segmentBase: { stayNights: 1, minStayNights: 1, maxStayNights: 1, destinationCity: { cityName: "成都" } }, hotel: { segmentRooms: [
          { masterHotelID: 101 }, { masterHotelID: 102 }, { masterHotelID: 103 },
        ] } },
      ] } });
      throw new Error(`unexpected endpoint ${endpoint}`);
    },
  };

  const result = await runProductPreflightApi(page, {
    basicInfo: { meetingCity: "成都", destinationCity: "成都", days: 2, nights: 1 }, presentation: preflightPresentation,
    sales: { productForm: "groupTour" }, commercial: { packageName: "成都2天1晚自由行" },
    operations: { hotelTier: "当地5钻酒店" },
    itinerary: [
      { day: 1, hotel: "成都酒店", hotelCandidates: [
        { hotelId: 101, hotelName: "酒店一", cityName: "成都" },
        { hotelId: 102, hotelName: "酒店二", cityName: "成都" },
        { hotelId: 103, hotelName: "酒店三", cityName: "成都" },
      ] },
      { day: 2, hotel: "无" },
    ],
  }, "78490989");

  assert.equal(result.resources.hotel.verified, true);
  assert.deepEqual((result.resources.hotel as any).segments[0].hotelIds, [101, 102, 103]);
  assert.equal(endpoints.some((endpoint) => /(?:saveSegment|submitSegments|initializeResource|sync)/i.test(endpoint)), false);
});

function versionedItineraryPage(draftDays: number, formalDays: number, requested: unknown[]) {
  return {
    evaluate: async (_fn: unknown, request: any) => {
      const endpoint = String(request?.endpoint ?? "");
      if (endpoint.endsWith("/getProductBaseInfo")) return success({ baseInfo: preflightBase(78490990) });
      if (endpoint.endsWith("/getPackageList")) return success({ itemList: [{ name: "成都2天1晚自由行", singleResourceId: 11 }] });
      if (endpoint.endsWith("/getdescriptionInfo")) return success(preflightDescription());
      if (endpoint.endsWith("/listProductClauses")) return success(preflightClauses());
      if (endpoint.endsWith("/getClausePackage")) return success({ clauseTypeDtos: [] });
      if (endpoint.endsWith("/searchProductImage.json")) return success(preflightCover());
      if (endpoint.endsWith("/getTourDailyDetail.json")) {
        const id = request?.body?.tourInfoId;
        requested.push(id);
        return success({ tourInfo: { tourDailyDescriptions: Array.from({ length: id === "draft-id" ? draftDays : formalDays }, () => ({})) } });
      }
      throw new Error(`unexpected endpoint ${endpoint}`);
    },
  };
}

test("显式 draft 行程 ID 读取草稿，不回退到 formal/audit 默认优先级", async () => {
  const requested: unknown[] = [];
  const result = await runProductPreflightApi(versionedItineraryPage(2, 1, requested), {
    basicInfo: { meetingCity: "成都", destinationCity: "成都", days: 2, nights: 1 }, presentation: preflightPresentation,
    commercial: { packageName: "成都2天1晚自由行" }, operations: {},
    itinerary: [{ day: 1, hotel: "无" }, { day: 2, hotel: "无" }],
  }, "78490990", { itineraryTourInfoId: "draft-id" });
  assert.equal(result.itinerary.tourInfoId, "draft-id");
  assert.deepEqual(requested, ["draft-id"]);
});

test("draft 行程错误时不能以正确的 formal 行程替代通过", async () => {
  const requested: unknown[] = [];
  await assert.rejects(() => runProductPreflightApi(versionedItineraryPage(1, 2, requested), {
    basicInfo: { meetingCity: "成都", destinationCity: "成都", days: 2, nights: 1 }, presentation: preflightPresentation,
    commercial: { packageName: "成都2天1晚自由行" }, operations: {},
    itinerary: [{ day: 1, hotel: "无" }, { day: 2, hotel: "无" }],
  }, "78490990", { itineraryTourInfoId: "draft-id" }), /行程预检回读天数不一致/);
  assert.deepEqual(requested, ["draft-id"]);
});

test("价格库存重复首日不能抵消缺失的次日", async () => {
  const first = localBusinessDate();
  const next = new Date(`${first}T00:00:00`); next.setDate(next.getDate() + 1);
  const second = localBusinessDate(next);
  const page = { evaluate: async (_fn: unknown, request: any) => {
    const endpoint = String(request?.endpoint ?? "");
    if (endpoint.endsWith("/getPackageList")) return success({ itemList: [{ singleResourceId: 11, optionalResourceId: 22 }] });
    if (endpoint.endsWith("/GetBatchOperateSchedule")) return success({ dates: [
      { adultPrice: { date: first, cost: 100, marketPrice: 200 }, inventory: { total: 10 } },
      { adultPrice: { date: first, cost: 100, marketPrice: 200 }, inventory: { total: 10 } },
    ] });
    throw new Error(`unexpected endpoint ${endpoint}`);
  } };
  await assert.rejects(() => verifyPricingInventoryReadback(page, {
    commercial: { pricing: { adult: 200, cost: { adult: 100 } }, inventory: { startDate: first, endDate: second, dailyQuota: 10 } },
  }, "78490990"), /缺少 1\/2 个日期/);
});

test("酒店资源回读逐日覆盖 5/2/5/5/0；同城但候选不同的夜晚不能合并", async () => {
  const candidates = (ids: number[], cityName: string) => ids.map((hotelId) => ({ hotelId, hotelName: `${cityName}-${hotelId}`, cityName }));
  const d1 = candidates([11, 12, 13, 14, 15], "汕头");
  const d2 = candidates([21, 22], "潮州");
  const d3 = candidates([31, 32, 33, 34, 35], "潮州");
  const d4 = candidates([41, 42, 43, 44, 45], "潮州");
  const page = { evaluate: async (_fn: unknown, request: any) => {
    if (!String(request?.endpoint ?? "").endsWith("/getSegments")) throw new Error(`unexpected endpoint ${request?.endpoint}`);
    return success({ draftProductSegments: { segments: [
      { segmentId: "full", segmentBase: { stayNights: 0 } },
      ...[d1, d2, d3, d4].map((day, index) => ({
        segmentId: `stay-${index + 1}`,
        segmentBase: { stayNights: 1, minStayNights: 1, maxStayNights: 1, destinationCity: { cityName: index === 0 ? "汕头" : "潮州" } },
        hotel: { segmentRooms: day.map((candidate) => ({ masterHotelID: candidate.hotelId })) },
      })),
    ] } });
  } };
  const result = await verifyHotelResourceReadback(page, {
    operations: { hotelResource: { source: "ctrip" } },
    itinerary: [
      { day: 1, hotel: "汕头酒店", hotelCandidates: d1 },
      { day: 2, hotel: "潮州酒店", hotelCandidates: d2 },
      { day: 3, hotel: "怀棠府邸", hotelCandidates: d3 },
      { day: 4, hotel: "有熊都潮州", hotelCandidates: d4 },
      { day: 5, hotel: "当日返程，不安排住宿" },
    ],
  }, "78490991");

  assert.deepEqual(result.dailyCandidateCounts, [
    { day: 1, candidateCount: 5 }, { day: 2, candidateCount: 2 },
    { day: 3, candidateCount: 5 }, { day: 4, candidateCount: 5 }, { day: 5, candidateCount: 0 },
  ]);
  assert.deepEqual(result.segments.map((segment: any) => [segment.dayNumbers, segment.hotelIds]), [
    [[1], [11, 12, 13, 14, 15]], [[2], [21, 22]],
    [[3], [31, 32, 33, 34, 35]], [[4], [41, 42, 43, 44, 45]],
  ]);
});

function hotelReadbackPage(actualIds: unknown[]) {
  return { evaluate: async (_fn: unknown, request: any) => {
    if (!String(request?.endpoint ?? "").endsWith("/getSegments")) throw new Error(`unexpected endpoint ${request?.endpoint}`);
    return success({ draftProductSegments: { segments: [
      { segmentId: "full", segmentBase: { stayNights: 0 } },
      {
        segmentId: "stay-1",
        segmentBase: { stayNights: 1, minStayNights: 1, maxStayNights: 1, destinationCity: { cityName: "潮州" } },
        hotel: { segmentRooms: actualIds.map((masterHotelID) => (
          masterHotelID === null ? null
            : typeof masterHotelID === "object" ? masterHotelID : { masterHotelID }
        )) },
      },
    ] } });
  } };
}

const fiveHotelCandidateProduct = {
  operations: { hotelResource: { source: "ctrip" } },
  itinerary: [{
    day: 1,
    hotel: "潮州酒店",
    hotelCandidates: [
      { hotelId: 108846358, hotelName: "酒店一", cityName: "潮州" },
      { hotelId: 27846526, hotelName: "酒店二", cityName: "潮州" },
      { hotelId: 99917488, hotelName: "酒店三", cityName: "潮州" },
      { hotelId: 132012928, hotelName: "酒店四", cityName: "潮州" },
      { hotelId: 115628789, hotelName: "酒店五", cityName: "潮州" },
    ],
  }],
};

test("酒店资源回读允许平台重排真实 5 个候选 ID，但保留资源段顺序和实际回读顺序", async () => {
  const result = await verifyHotelResourceReadback(hotelReadbackPage([
    27846526, 99917488, 108846358, 115628789, 132012928,
  ]), fiveHotelCandidateProduct, "78490992");
  assert.deepEqual(result.segments.map((segment: any) => segment.hotelIds), [[
    27846526, 99917488, 108846358, 115628789, 132012928,
  ]]);
});

test("酒店资源回读候选缺漏、多项或重复时失败，不只按数量放行", async () => {
  const cases = [
    [27846526, 99917488, 108846358, 115628789],
    [27846526, 99917488, 108846358, 115628789, 132012928, 777777777],
    [27846526, 99917488, 108846358, 115628789, 115628789],
  ];
  for (const actualIds of cases) {
    await assert.rejects(
      () => verifyHotelResourceReadback(hotelReadbackPage(actualIds), fiveHotelCandidateProduct, "78490992"),
      /候选 ID 集合不一致/,
    );
  }
});

test("酒店资源回读遇到无效、零、NaN 或空房间时失败，不吞掉异常房间", async () => {
  for (const invalidId of [0, Number.NaN, null]) {
    await assert.rejects(
      () => verifyHotelResourceReadback(hotelReadbackPage([27846526, 99917488, 108846358, 115628789, invalidId]), fiveHotelCandidateProduct, "78490992"),
      /候选 ID 集合不一致/,
    );
  }
});
