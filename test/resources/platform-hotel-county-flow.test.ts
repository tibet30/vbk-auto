import assert from "node:assert/strict";
import test from "node:test";
import { ensurePlatformHotelRulesApi, verifyPlatformHotelDraftRulesReadback, verifyPlatformHotelRulesReadback } from "../../src/main/automation/ctrip/hotel-rule-api.js";
import { resolveResourceSegmentCityApi } from "../../src/main/automation/ctrip/vehicle-resource-api.js";
import { buildFillMap } from "../../src/main/automation/automation.main/automation.main.run-one/fill-map.js";
import { normalisePlatformHotelProduct } from "../../src/shared/platform-hotel-rules.js";

const cities = [
  { cityId: 21710, cityName: "眉县" }, { cityId: 21821, cityName: "太白县" },
  { cityId: 21367, cityName: "留坝" }, { cityId: 1920, cityName: "洋县" }, { cityId: 129, cityName: "汉中" },
].map(city => ({ ...city, countryName: "中国", provinceName: "陕西" }));
const xian = { cityId: 10, cityName: "西安", countryName: "中国", provinceName: "陕西" };
const product = () => normalisePlatformHotelProduct({ sales: { productForm: "privateTour" },
  basicInfo: { meetingCity: "西安", province: "陕西", nights: 5 },
  itinerary: ["眉", "太白", "留坝", "洋", "汉中"].map((hotelCity, index) => ({ day: index + 1, hotelCity, hotel: "平台酒店" }))
    .concat([{ day: 6, hotelCity: "", hotel: "无当日住宿安排" }]),
});

function fixture() {
  const base = { segmentNumber: 1, stayNights: 5, minStayNights: 5, maxStayNights: 5,
    departureCity: xian, destinationCity: xian, deleteable: false };
  const state = { saves: 0, keywords: [] as string[], corrupt: false, segments: [
    { segmentId: "full", productId: "draft-100", segmentBase: base,
      packages: [{ packageId: 12 }], segmentResourceGroups: [{ resourceGroupId: 2206177 }] },
    { segmentId: "end", productId: "draft-100", segmentBase: { ...base, segmentNumber: 2,
      stayNights: 0, minStayNights: 0, maxStayNights: 0, deleteable: true }, packages: [], segmentResourceGroups: [] },
  ] as any[] };
  const page = { nativeOnly: true, evaluate: async () => { throw new Error("禁止页面脚本"); },
    vbkSessionFetch: async (request: any) => {
      const action = new URL(request.endpoint).pathname.split("/").at(-1);
      assert.ok(["getSegments", "suggestDepartureCity", "saveSegment"].includes(action!), `禁止酒店筛选、提交及发布：${action}`);
      const body = request.body;
      let extra: Record<string, unknown> = {};
      if (action === "suggestDepartureCity") {
        state.keywords.push(body.keyword);
        const matches = cities.filter(city => city.cityName.includes(body.keyword)
          && !(body.keyword === "眉" || body.keyword === "洋"));
        extra = { cities: body.keyword === "太白" ? [
          { cityId: 61671, cityName: "太白市", countryName: "韩国", provinceName: "江原" }, ...matches,
        ] : matches };
      }
      if (action === "saveSegment") {
        state.saves++;
        const segment = structuredClone(body.segment);
        assert.equal(segment.productId, "draft-100");
        assert.equal(segment.hotel?.segmentRooms?.length ?? 0, 0);
        if (segment.hotel?.systemHotel) {
          assert.deepEqual(segment.hotel.systemHotel.hotelStar, [3, 4, 5]);
          if (state.corrupt) segment.segmentBase.destinationCity = xian;
          segment.hotel.segmentRooms = null;
        }
        if (Number(segment.segmentId) === 0) {
          segment.segmentId = `stay-${state.saves}`;
          state.segments.splice(-1, 0, segment);
          state.segments.forEach((s, index) => { s.segmentBase.segmentNumber = index + 1; });
        } else state.segments = state.segments.map(s => s.segmentId === segment.segmentId ? segment : s);
      }
      if (action === "getSegments") extra = { draftProductSegments: { segments: structuredClone(state.segments) },
        productSegments: { segments: structuredClone(state.segments) } };
      return { status: 200, durationMs: 1, ctx: {} as any, payload: { ResponseStatus: { Ack: "Success" }, ...extra } };
    } };
  return { page, state };
}

test("西安六日五晚短县名完成平台规则保存回读，不筛酒店且重复执行零写入", async () => {
  const { page, state } = fixture();
  const input = product();
  assert.ok(input.itinerary.every((day: any) => !day.hotelCandidates && !day.hotelRequirement));
  const result: any = await buildFillMap({ page, productData: input, productId: "100", localProductId: "local-100",
    ctx: { db: { getProduct: () => ({ product: input }) }, persistProduct: (_id: string, saved: any) => {
      assert.ok(saved.itinerary.every((day: any) => !day.hotelCandidates && !day.hotelRequirement));
      assert.equal(saved.operations.hotelMatchingMode, "rules");
    } } } as any).hotelResource();
  assert.equal(result.verified, true);
  assert.equal(result.layout.created, 5);
  assert.equal(result.positiveSegmentCount, 5);
  assert.deepEqual(state.keywords, ["眉", "眉县", "太白", "留坝", "洋", "洋县", "汉中"]);
  assert.deepEqual(state.segments.slice(1, -1).map(s => [s.segmentBase.destinationCity.cityId, s.segmentBase.stayNights]),
    cities.map(city => [city.cityId, 1]));
  assert.deepEqual(state.segments[0].packages, [{ packageId: 12 }]);
  assert.deepEqual(state.segments[0].segmentResourceGroups, [{ resourceGroupId: 2206177 }]);
  assert.equal(state.segments[0].segmentBase.stayNights, 0);
  assert.equal(state.segments.at(-1).segmentBase.stayNights, 0);
  assert.equal((await verifyPlatformHotelDraftRulesReadback(page, input, "100")).segmentIds.length, 5);
  assert.equal((await verifyPlatformHotelRulesReadback(page, input, "100")).verified, true);
  const saves = state.saves, queries = state.keywords.length;
  await ensurePlatformHotelRulesApi(page, input, "100", { draftOnly: true });
  assert.equal(state.saves, saves);
  assert.equal(state.keywords.length, queries);
});

test("短县名补查询仍要求省份唯一，不允许同名外省和重复城市", async () => {
  for (const returned of [
    [{ cityId: 21710, cityName: "眉县", countryName: "中国", provinceName: "四川" }],
    [cities[0], { ...cities[0], cityId: 999 }],
  ]) {
    const keywords: string[] = [];
    const page = { evaluate: async (_fn: unknown, request: any) => {
      keywords.push(request.body.keyword);
      return { status: 200, payload: { ResponseStatus: { Ack: "Success" }, cities: request.body.keyword === "眉县" ? returned : [] } };
    } };
    await assert.rejects(resolveResourceSegmentCityApi(page, "眉", { province: "陕西", countryName: "中国" }), /无法唯一匹配/);
    assert.deepEqual(keywords, ["眉", "眉县"]);
  }
});

test("住宿城市协议缺失不能被县名补查询掩盖", async () => {
  let calls = 0;
  const page = { evaluate: async () => { calls++; return { status: 200, payload: { ResponseStatus: { Ack: "Success" } } }; } };
  await assert.rejects(resolveResourceSegmentCityApi(page, "眉", { province: "陕西" }), /缺少 cities 列表/);
  assert.equal(calls, 1);
});

test("保存后实际住宿地点改变必须阻塞，不能以短名等价掩盖错误城市", async () => {
  const { page, state } = fixture(); state.corrupt = true;
  await assert.rejects(ensurePlatformHotelRulesApi(page, product(), "100", { draftOnly: true }), /住宿城市或晚数回读不一致/);
});

test("已有同名外省住宿段必须重新匹配，草稿与正式回读均拒绝外省", async () => {
  const { page, state } = fixture(); const input = product();
  await ensurePlatformHotelRulesApi(page, input, "100", { draftOnly: true });
  const first = () => state.segments[1];
  first().segmentBase.destinationCity = { ...cities[0], cityId: 999, provinceName: "四川" };
  await assert.rejects(verifyPlatformHotelDraftRulesReadback(page, input, "100"), /住宿城市或晚数回读不一致/);
  await assert.rejects(verifyPlatformHotelRulesReadback(page, input, "100"), /住宿城市或晚数回读不一致/);
  await ensurePlatformHotelRulesApi(page, input, "100", { draftOnly: true });
  assert.deepEqual(first().segmentBase.destinationCity, cities[0]);
  assert.equal((await verifyPlatformHotelDraftRulesReadback(page, input, "100")).verified, true);
});

test("跨省住宿按当晚地点地域回读，不能套用抵达城市省份", async () => {
  const { page, state } = fixture(); const input = product();
  await ensurePlatformHotelRulesApi(page, input, "100", { draftOnly: true });
  input.itinerary[0].spots = [{ city: "成都", province: "四川" }];
  input.itinerary[0].hotelCity = "成都";
  state.segments[1].segmentBase.destinationCity = { cityId: 28, cityName: "成都", countryName: "中国", provinceName: "四川" };
  state.segments[1].hotel.systemHotel.geoLocation = { globalId: "28", name: "成都", categoryId: 3 };
  assert.equal((await verifyPlatformHotelDraftRulesReadback(page, input, "100")).verified, true);
});
