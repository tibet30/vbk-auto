import assert from "node:assert/strict";
import test from "node:test";
import { ensurePlatformHotelRulesApi, verifyPlatformHotelDraftRulesReadback } from "../../src/main/automation/ctrip/hotel-rule-api.js";
import { normalisePlatformHotelProduct } from "../../src/shared/platform-hotel-rules.js";

const city = (cityId: number, cityName: string) => ({ cityId, cityName, countryName: "中国", provinceName: "四川" });
const known: Record<string, any> = { 成都: city(28, "成都"), 黑水: city(21928, "黑水"), 松潘: city(1372, "松潘"), 九寨沟: city(91, "九寨沟") };
const RULE_HOTEL = "使用携程平台酒店，自动匹配三钻、四钻、五钻酒店";

/** 真实卡死样本：成都 4 天 3 晚私家团（`37feb911`），平台城市表没有川主寺、九寨沟沟口。 */
function product() {
  return normalisePlatformHotelProduct({
    sales: { productForm: "privateTour" },
    basicInfo: { meetingCity: "成都", destinationCity: "成都", province: "四川", days: 4, nights: 3,
      userIdea: "Day1：成都-毕棚沟-毕棚沟住宿-住：黑水\nDay2：黑水-达古冰川-住：川主寺\nDay3：川主寺-黄龙景区-住：九寨沟沟口\nDay4：九寨沟-成都" },
    operations: { hotelMatchingMode: "rules", hotelRules: { autoMatch: true, grades: [3, 4, 5] } },
    itinerary: [
      { day: 1, hotelCity: "黑水", hotel: RULE_HOTEL, spots: [] },
      { day: 2, hotelCity: "川主寺", hotel: RULE_HOTEL, spots: [] },
      { day: 3, hotelCity: "九寨沟沟口", hotel: RULE_HOTEL, spots: [] },
      { day: 4, hotel: "无当日住宿安排", spots: [] },
    ],
  });
}

function fixture() {
  const chengdu = known.成都;
  const base = { segmentNumber: 1, stayNights: 0, minStayNights: 0, maxStayNights: 0,
    departureCity: chengdu, destinationCity: chengdu, deleteable: false };
  const state = { saves: 0, keywords: [] as string[], segments: [
    { segmentId: "full", productId: "draft-200", segmentBase: base, packages: [], segmentResourceGroups: [] },
    { segmentId: "end", productId: "draft-200", segmentBase: { ...base, segmentNumber: 2, deleteable: true },
      packages: [], segmentResourceGroups: [] },
  ] as any[] };
  const page = { nativeOnly: true, evaluate: async () => { throw new Error("禁止页面脚本"); },
    vbkSessionFetch: async (request: any) => {
      const action = new URL(request.endpoint).pathname.split("/").at(-1);
      assert.ok(["getSegments", "suggestDepartureCity", "saveSegment"].includes(action!), `禁止酒店筛选、提交及发布：${action}`);
      if (action === "suggestDepartureCity") {
        state.keywords.push(request.body.keyword);
        const hit = known[request.body.keyword];
        // 与平台实测一致：查无结果时整个 cities 字段缺失。
        return { status: 200, payload: { ResponseStatus: { Ack: "Success" }, ...(hit ? { cities: [hit] } : {}) } };
      }
      if (action === "saveSegment") {
        state.saves++;
        const segment = structuredClone(request.body.segment);
        if (Number(segment.segmentId) === 0) {
          segment.segmentId = `stay-${state.saves}`;
          state.segments.splice(-1, 0, segment);
        } else state.segments = state.segments.map(saved => saved.segmentId === segment.segmentId ? segment : saved);
        state.segments.forEach((saved, index) => { saved.segmentBase.segmentNumber = index + 1; });
      }
      const extra = action === "getSegments"
        ? { draftProductSegments: { segments: structuredClone(state.segments) }, productSegments: { segments: structuredClone(state.segments) } }
        : {};
      return { status: 200, durationMs: 1, ctx: {} as any, payload: { ResponseStatus: { Ack: "Success" }, ...extra } };
    } };
  return { page, state };
}

test("川主寺、九寨沟沟口住宿夜按所属县松潘、九寨沟保存酒店规则并通过回读", async () => {
  const { page, state } = fixture();
  const input = product();
  const result: any = await ensurePlatformHotelRulesApi(page, input, "draft-200", { draftOnly: true });
  assert.equal(result.verified, true);
  assert.ok(!state.keywords.some(keyword => keyword === "川主寺" || keyword === "九寨沟沟口"), `误查：${state.keywords.join("|")}`);
  const stays = state.segments.filter((segment: any) => Number(segment.segmentBase.stayNights) > 0);
  assert.deepEqual(stays.map((segment: any) => [segment.segmentBase.destinationCity.cityId, segment.segmentBase.stayNights]),
    [[21928, 1], [1372, 1], [91, 1]]);
  assert.equal((await verifyPlatformHotelDraftRulesReadback(page, input, "draft-200")).segmentIds.length, 3);
  // 产品侧仍保留运营原文的住宿落点。
  assert.deepEqual(input.itinerary.slice(0, 3).map((day: any) => day.hotelCity), ["黑水", "川主寺", "九寨沟沟口"]);
});
