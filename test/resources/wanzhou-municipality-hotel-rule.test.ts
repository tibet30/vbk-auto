import assert from "node:assert/strict";
import test from "node:test";
import { ensurePlatformHotelRulesApi, verifyPlatformHotelDraftRulesReadback } from "../../src/main/automation/ctrip/hotel-rule-api.js";
import { normalisePlatformHotelProduct } from "../../src/shared/platform-hotel-rules.js";

const chongqing = { cityId: 4, cityName: "重庆", countryName: "中国", provinceName: "重庆" };

/** 真实卡死样本：万州 5 天 4 晚私家团的万州住宿夜。 */
function product() {
  return normalisePlatformHotelProduct({
    sales: { productForm: "privateTour" },
    basicInfo: { meetingCity: "万州", destinationCity: "万州", province: "重庆", days: 2, nights: 1 },
    itinerary: [
      { day: 1, hotelCity: "万州", hotel: "平台酒店", description: "当晚住万州" },
      { day: 2, hotelCity: "", hotel: "无当日住宿安排", description: "返程" },
    ],
  });
}

function fixture() {
  const base = { segmentNumber: 1, stayNights: 1, minStayNights: 1, maxStayNights: 1,
    departureCity: chongqing, destinationCity: chongqing, deleteable: false };
  const state = { saves: 0, keywords: [] as string[], segments: [
    { segmentId: "full", productId: "draft-100", segmentBase: base, packages: [], segmentResourceGroups: [] },
    { segmentId: "end", productId: "draft-100",
      segmentBase: { ...base, segmentNumber: 2, stayNights: 0, minStayNights: 0, maxStayNights: 0, deleteable: true },
      packages: [], segmentResourceGroups: [] },
  ] as any[] };
  const page = { nativeOnly: true, evaluate: async () => { throw new Error("禁止页面脚本"); },
    vbkSessionFetch: async (request: any) => {
      const action = new URL(request.endpoint).pathname.split("/").at(-1);
      assert.ok(["getSegments", "suggestDepartureCity", "saveSegment"].includes(action!), `禁止酒店筛选、提交及发布：${action}`);
      if (action === "suggestDepartureCity") {
        state.keywords.push(request.body.keyword);
        const cities = request.body.keyword === "重庆" ? [chongqing] : [];
        return { status: 200, payload: { ResponseStatus: { Ack: "Success" }, cities } };
      }
      if (action === "saveSegment") {
        state.saves++;
        const segment = structuredClone(request.body.segment);
        assert.equal(segment.productId, "draft-100");
        if (segment.hotel?.systemHotel) assert.deepEqual(segment.hotel.systemHotel.hotelStar, [3, 4, 5]);
        if (Number(segment.segmentId) === 0) {
          segment.segmentId = `stay-${state.saves}`;
          state.segments.splice(-1, 0, segment);
        } else state.segments = state.segments.map(saved => saved.segmentId === segment.segmentId ? segment : saved);
        state.segments.forEach((saved, index) => { saved.segmentBase.segmentNumber = index + 1; });
      }
      const extra = action === "getSegments"
        ? { draftProductSegments: { segments: structuredClone(state.segments) },
          productSegments: { segments: structuredClone(state.segments) } }
        : {};
      return { status: 200, durationMs: 1, ctx: {} as any, payload: { ResponseStatus: { Ack: "Success" }, ...extra } };
    } };
  return { page, state };
}

test("万州住宿夜按平台可写城市重庆保存酒店规则并通过回读", async () => {
  const { page, state } = fixture();
  const input = product();
  const result: any = await ensurePlatformHotelRulesApi(page, input, "draft-100", { draftOnly: true });
  assert.equal(result.verified, true);
  assert.equal(result.positiveSegmentCount, 1);
  // 平台城市列表没有万州，只允许查询可写城市重庆。
  assert.deepEqual(state.keywords, ["重庆"]);
  const stays = state.segments.filter((segment: any) => Number(segment.segmentBase.stayNights) > 0);
  assert.equal(stays.length, 1);
  assert.equal(stays[0].segmentBase.destinationCity.cityId, 4);
  assert.equal(stays[0].segmentBase.destinationCity.cityName, "重庆");
  assert.equal((await verifyPlatformHotelDraftRulesReadback(page, input, "draft-100")).segmentIds.length, 1);
});

test("万州住宿仍保留产品侧的万州锚点与晚数", () => {
  const input = product();
  assert.equal(input.itinerary[0].hotelCity, "万州");
  assert.equal(input.basicInfo.meetingCity, "万州");
});
