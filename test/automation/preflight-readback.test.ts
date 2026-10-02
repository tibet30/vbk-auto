import assert from "node:assert/strict";
import test from "node:test";
import {
  verifyBasicInfoReadback,
  verifyPresentationReadback,
  verifyTermsReadback,
} from "../../src/main/automation/ctrip/preflight-readback.ts";
import { buildReadOnlyItineraryReadbackExpectations } from "../../src/main/automation/ctrip/preflight-readonly.ts";
import { verifyItineraryReadback } from "../../src/main/automation/ctrip/itinerary-api/readback.ts";

const success = (payload: Record<string, unknown>) => ({ status: 200, payload: { ResponseStatus: { Ack: "Success" }, ...payload }, durationMs: 1, ctx: {} });

const product = {
  basicInfo: { meetingCity: "潮州", destinationCity: "潮州", days: 5, nights: 4 },
  presentation: {
    cover: { source: "ctripLibrary", imageId: 25345261 },
    recommendations: [
      { category: "服务保障", text: "专属行程服务" },
      { category: "贴心赠送", text: "出行贴心安排" },
      { category: "精选酒店", text: "舒适住宿体验" },
    ],
    features: "<p>古城与海岛深度体验</p>",
  },
  itinerary: [{ spots: [
    { name: "广济桥", poiName: "广济桥", poiId: 85862, description: "远观广济桥（不上桥）。" },
    { name: "开元寺", poiName: "开元寺", poiId: 85864, description: "入内参观。" },
  ] }],
};

test("基本信息回读锁定潮州 5 天 4 晚", () => {
  assert.deepEqual(verifyBasicInfoReadback({
    productId: 79189107,
    masterDepartureCityId: 100,
    masterDepartureCityName: "潮州市",
    destinationCityID: 100,
    destinationCityName: "潮州市",
    travelDays: 5,
    maxTravelDays: 5,
    travelNights: 4,
    vendorProductCode: "CZ-5D4N",
  }, product, "79189107"), {
    cityId: 100, meetingCity: "潮州", destinationCity: "潮州", days: 5, nights: 4,
  });
});

test("产品图文只接受唯一的真实图库封面与已保存文案", async () => {
  const page = { evaluate: async (_fn: unknown, request: any) => {
    if (String(request.endpoint).endsWith("/searchProductImage.json")) {
      return success({ productImages: [{ imageInfo: { imageId: 25345261, accompanyTourInfo: { imageTypeId: 2 } } }] });
    }
    throw new Error(`unexpected endpoint ${request.endpoint}`);
  } };
  const result = await verifyPresentationReadback(page, product, "79189107", {
    pmRcmdItems: product.presentation.recommendations.map(({ text }) => ({ rcmdDesc: text })),
    productDesc: { productDesc: product.presentation.features },
  });
  assert.deepEqual(result, { coverImageId: 25345261, recommendationCount: 3, featuresSaved: true, draftFallback: false });
});

test("产品图文拒绝只有相同前 40 字的截断特色文案", async () => {
  const features = `<p>${"潮州古城深度体验".repeat(8)}尾段必须保留</p>`;
  const longProduct = structuredClone(product);
  longProduct.presentation.features = features;
  const page = { evaluate: async (_fn: unknown, request: any) => {
    if (String(request.endpoint).endsWith("/searchProductImage.json")) {
      return success({ productImages: [{ imageInfo: { imageId: 25345261, accompanyTourInfo: { imageTypeId: 2 } } }] });
    }
    throw new Error(`unexpected endpoint ${request.endpoint}`);
  } };
  await assert.rejects(() => verifyPresentationReadback(page, longProduct, "79189107", {
    pmRcmdItems: longProduct.presentation.recommendations.map(({ text }) => ({ rcmdDesc: text })),
    productDesc: { productDesc: `<p>${"潮州古城深度体验".repeat(8)}</p>` },
  }), /产品特色文案不一致/);
});

test("产品图文接受已绑定的手动上传封面与 draft-only 占位封面", async () => {
  const page = { evaluate: async (_fn: unknown, request: any) => {
    if (String(request.endpoint).endsWith("/searchProductImage.json")) {
      return success({ productImages: [{ imageInfo: { imageId: 918, accompanyTourInfo: { imageTypeId: 2 } } }] });
    }
    throw new Error(`unexpected endpoint ${request.endpoint}`);
  } };
  const info = {
    pmRcmdItems: product.presentation.recommendations.map(({ text }) => ({ rcmdDesc: text })),
    productDesc: { productDesc: product.presentation.features },
  };
  const manual = structuredClone(product);
  manual.presentation.cover = { source: "manualUpload", remoteImageId: 918 };
  assert.equal((await verifyPresentationReadback(page, manual, "79189107", info)).coverImageId, 918);

  const placeholder = structuredClone(product);
  placeholder.presentation.cover = { source: "ctripLibrary", poi: "潮州古城" };
  placeholder.presentation.coverFallback = {
    slotKey: "presentation.cover", assetKey: "cover-landscape", reason: "search_unavailable",
    createdAt: "2026-10-01T00:00:00.000Z", remoteImageId: 918,
  };
  placeholder.commercial = { release: { submitReview: false, publishAfterApproval: false } };
  assert.equal((await verifyPresentationReadback(page, placeholder, "79189107", info)).draftFallback, true);
});

test("条款回读以实际条款包核验广济桥外观不进入成人或儿童门票", async () => {
  const page = { evaluate: async (_fn: unknown, request: any) => {
    const endpoint = String(request.endpoint);
    if (endpoint.endsWith("/suggestPoi")) {
      const keyword = request.body?.keyword;
      return success({ poiList: [{
        poiId: keyword === "广济桥" ? 85862 : 85864,
        poiType: { key: 1, name: "景点" },
        ticketType: { key: 1, name: "收费" },
      }] });
    }
    if (endpoint.endsWith("/getClausePackage")) return success({ clauseTypeDtos: [{
      clauseTypeId: 8,
      clauseItemDtos: [{ clauseItemId: 13, selected: "T", clauseComponentDtos: [{ componentCode: "landticketremarks", value: "开元寺" }] }, {
        clauseItemId: 10087, selected: "T", clauseComponentDtos: [{ componentCode: "landticket2", value: "开元寺" }],
      }],
      containers: [],
    }] });
    throw new Error(`unexpected endpoint ${endpoint}`);
  } };
  const tabs = [1, 2, 3, 4].map(() => ({
    centralDataDto: { additionalInfoDto: { firstClassTypeIds: [8] }, filterConditionDto: { productId: 79189107 } },
  }));
  const result = await verifyTermsReadback(page, product, "79189107", tabs);
  assert.equal(result.adultTicketInclusionText, "开元寺");
  assert.equal(result.tabs.length, 4);
});

test("条款回读拒绝 selectedClauseItems 中异常的组件结构", async () => {
  const page = { evaluate: async (_fn: unknown, request: any) => {
    if (String(request.endpoint).endsWith("/getClausePackage")) return success({ clauseTypeDtos: [{
      clauseTypeId: 8,
      clauseItemDtos: [{ clauseItemId: 13, selected: "T", clauseComponentDtos: [{
        componentCode: { name: "landticketremarks" }, value: "开元寺",
      }] }],
      containers: [],
    }] });
    throw new Error(`unexpected endpoint ${request.endpoint}`);
  } };
  const tabs = [1, 2, 3, 4].map(() => ({
    centralDataDto: { additionalInfoDto: { firstClassTypeIds: [8] }, filterConditionDto: { productId: 79189107 } },
  }));
  await assert.rejects(() => verifyTermsReadback(page, {
    ...product,
    itinerary: [],
  }, "79189107", tabs), /componentCode 结构异常/);
});

test("只读恢复预检补齐免费 POI 票型并接受远端无需门票回读", async () => {
  const originalFetch = globalThis.fetch;
  const hadDocument = Object.prototype.hasOwnProperty.call(globalThis, "document");
  const originalDocument = (globalThis as any).document;
  const requestedPaths: string[] = [];
  (globalThis as any).document = { cookie: "" };
  (globalThis as any).fetch = async (input: unknown) => {
    const path = new URL(String(input)).pathname;
    requestedPaths.push(path);
    const payload = path.endsWith("/suggestPoi")
      ? { ResponseStatus: { Ack: "Success" }, poiList: [{
        poiId: 85864, poiName: "开元寺", poiType: { key: 1, name: "景点" }, ticketType: { key: 2, name: "免费" },
      }] }
      : path.endsWith("/getTourDailyDetail.json")
        ? { ResponseStatus: { Ack: "Success" }, tourInfo: { tourDailyDescriptions: [{
          dailyDescription: "第1天：开元寺",
          useCar: { key: "B", name: "包车" },
          tourDailyInfos: [
            { activeType: { key: 25, name: "集合" }, tourDailyPackageGatherList: [{ serviceAllDay: true }] },
            { activeType: { key: 3, name: "景点" }, tourDailyPois: [{
              poi: { poiId: 85864, poiName: "开元寺" }, suffixName: { key: 11, name: "无需门票" },
            }] },
            { activeType: { key: 0, name: "餐饮" }, tourDailyDinner: { dinnerType: { key: "L" }, includeAdult: { key: "E" } } },
            { activeType: { key: 26, name: "解散" }, tourDailyPackageDismissList: [{ serviceAllDay: true }] },
          ],
        }] } }
        : { ResponseStatus: { Ack: "Failure", Errors: [{ Message: `unexpected ${path}` }] } };
    return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
  };
  const page = { evaluate: async (fn: any, arg: any) => fn(arg) };
  const readOnlyProduct = {
    itinerary: [{
      day: 1, title: "第1天：开元寺", description: "游览古寺", hotel: "", meals: "自理",
      spots: [{ name: "开元寺", poiName: "开元寺", poiId: 85864, kind: "attraction" as const }],
    }],
    operations: { transport: "charter" as const, mealsIncluded: false },
  };
  try {
    const expectations = await buildReadOnlyItineraryReadbackExpectations(page, readOnlyProduct, {});
    assert.equal(expectations.days[0]?.pois[0]?.suffixKey, 11);
    const summary = await verifyItineraryReadback(page, "draft-1", expectations);
    assert.equal(summary.spots, 1);
    assert.deepEqual(requestedPaths, [
      "/restapi/soa2/20049/suggestPoi",
      "/restapi/soa2/20049/getTourDailyDetail.json",
    ]);
  } finally {
    (globalThis as any).fetch = originalFetch;
    if (hadDocument) (globalThis as any).document = originalDocument;
    else delete (globalThis as any).document;
  }
});
