import assert from "node:assert/strict";
import test from "node:test";
import { ensurePlatformHotelRulesApi, verifyPlatformHotelRulesReadback, verifyPlatformHotelDraftRulesReadback } from "../../src/main/automation/ctrip/hotel-rule-api.js";
import { normalisePlatformHotelProduct } from "../../src/shared/platform-hotel-rules.js";

async function withSegments(run: (state: { segments: any[]; saves: number; corrupt: boolean }) => Promise<void>) {
  const oldFetch = globalThis.fetch, oldDocument = (globalThis as any).document;
  const city = { cityId: 28, cityName: "成都" };
  const state = { saves: 0, corrupt: false, segments: [
    { segmentId: "full", segmentBase: { segmentNumber: 1, stayNights: 0, minStayNights: 0, maxStayNights: 0, destinationCity: city } },
    { segmentId: "stay", segmentBase: { segmentNumber: 2, stayNights: 2, minStayNights: 2, maxStayNights: 2, destinationCity: city }, hotel: { segmentRooms: [{ hotelId: 1 }] } },
    { segmentId: "end", segmentBase: { segmentNumber: 3, stayNights: 0, minStayNights: 0, maxStayNights: 0, destinationCity: city } },
  ] as any[] };
  (globalThis as any).document = { cookie: "GUID=isolated" };
  globalThis.fetch = (async (url: any, init: any) => {
    const path = new URL(String(url)).pathname;
    assert.match(path, /getSegments|saveSegment/);
    if (path.endsWith("saveSegment")) {
      state.saves++;
      const segment = JSON.parse(init.body).segment;
      assert.equal(segment.hotel.systemHotel.goodHotel, "F", "平台枚举字段不能传布尔值");
      assert.equal(typeof segment.hotel.systemHotel.geoLocation.globalId, "string");
      if (state.corrupt) segment.hotel.systemHotel.hotelStar = [4];
      segment.hotel.segmentRooms = null;
      segment.hotel.segmentRoomBlackList = null;
      segment.hotel.systemHotel.zones = [{ key: "0", value: "不限" }];
      segment.hotel.systemHotel.locations = [{ key: "0", value: "不限" }];
      state.segments = state.segments.map(s => s.segmentId === segment.segmentId ? segment : s);
    }
    return new Response(JSON.stringify({ ResponseStatus: { Ack: "Success" },
      draftProductSegments: { segments: state.segments }, productSegments: { segments: state.segments } }));
  }) as typeof fetch;
  try { await run(state); } finally { globalThis.fetch = oldFetch; (globalThis as any).document = oldDocument; }
}
const page = { evaluate: async (fn: any, arg: any) => fn(arg) };
const product = () => normalisePlatformHotelProduct({ sales: { productForm: "privateTour" }, basicInfo: { meetingCity: "成都" },
  itinerary: [{ day: 1, hotel: "旧酒店" }, { day: 2, hotel: "民宿" }, { day: 3, hotel: "无当日住宿安排" }] });

test("旧指定酒店转换后草稿和正式规则一致，重复保存不产生写入", async () => withSegments(async state => {
  const first = await ensurePlatformHotelRulesApi(page, product(), "100");
  assert.equal(first.verified, true); assert.equal(state.saves, 1);
  assert.equal(state.segments[1].hotel.segmentRooms, null);
  assert.deepEqual(state.segments[1].hotel.systemHotel.hotelStar, [3, 4, 5]);
  assert.equal((await verifyPlatformHotelRulesReadback(page, product(), "100")).verified, true);
  await ensurePlatformHotelRulesApi(page, product(), "100"); assert.equal(state.saves, 1);
  state.segments[1].hotel.systemHotel.hotelStar = [4];
  await assert.rejects(verifyPlatformHotelRulesReadback(page, product(), "100"), /正式回读不一致/);
}));

test("保存成功但规则回读等级错误不得完成", async () => withSegments(async state => {
  state.corrupt = true;
  await assert.rejects(ensurePlatformHotelRulesApi(page, product(), "100"), /草稿回读不一致/);
}));

test("状态同步只回读已有草稿，规则错误不补写或初始化资源", async () => withSegments(async state => {
  await ensurePlatformHotelRulesApi(page, product(), "100");
  const saves = state.saves;
  assert.deepEqual(await verifyPlatformHotelDraftRulesReadback(page, product(), "100"), {
    verified: true, productId: "100", segmentIds: ["stay"], rules: { autoMatch: true, grades: [3, 4, 5] },
    specifiedHotels: [], draftOnly: true,
  });
  state.segments[1].hotel.systemHotel.hotelStar = [4];
  await assert.rejects(verifyPlatformHotelDraftRulesReadback(page, product(), "100"), /草稿回读不一致/);
  assert.equal(state.saves, saves);
}));

test("仅正式段回读成功也不能替代草稿证据", async () => withSegments(async state => {
  await ensurePlatformHotelRulesApi(page, product(), "100");
  const reader = { nativeOnly: true, evaluate: async () => { throw new Error("禁止页面脚本"); },
    vbkSessionFetch: async (request: any) => {
      assert.ok(request.endpoint.endsWith("getSegments"));
      return { status: 200, payload: { ResponseStatus: { Ack: "Success" }, productSegments: { segments: state.segments } }, durationMs: 1, ctx: {} };
    } };
  await assert.rejects(verifyPlatformHotelDraftRulesReadback(reader, product(), "100"), /未返回酒店规则草稿/);
}));

test("全程段重复住宿或无住宿段晚数无效时，草稿和正式回读均阻塞且不补写", async () => withSegments(async state => {
  await ensurePlatformHotelRulesApi(page, product(), "100");
  const saved = structuredClone(state.segments), saves = state.saves;
  for (const [index, key, value] of [[0, "stayNights", 2], [0, "maxStayNights", 2],
    [2, "stayNights", -1], [2, "minStayNights", "invalid"]] as const) {
    state.segments = structuredClone(saved);
    state.segments[index].segmentBase[key] = value;
    await assert.rejects(verifyPlatformHotelDraftRulesReadback(page, product(), "100"), /住宿晚数无效/);
    await assert.rejects(verifyPlatformHotelRulesReadback(page, product(), "100"), /住宿晚数无效/);
    assert.equal(state.saves, saves);
  }
}));
