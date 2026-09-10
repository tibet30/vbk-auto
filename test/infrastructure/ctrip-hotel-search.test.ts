import test from "node:test";
import assert from "node:assert/strict";
import {
  buildHotelListUrl,
  extractCtripHotelListFromHtml,
  nextHotelSearchDates,
  readCtripHotelCandidates,
  selectCtripHotelContext,
  limitItineraryHotelStays,
  hotelAnchorNameForDay,
  hotelCandidatesForTier,
} from "../../src/main/infrastructure/ctrip-hotel-search.js";
import { hasItineraryHotelStay } from "../../src/shared/itinerary-hotel.js";

test("送站日的酒店“无”不会进入酒店候选检索", () => {
  assert.equal(hasItineraryHotelStay("无"), false);
  assert.equal(hasItineraryHotelStay("维也纳酒店"), true);
});

test("酒店候选解析只保留产品 nights 对应的住宿日", () => {
  const itinerary = [
    { day: 1, hotel: "江孜酒店", hotelCandidates: [{ hotelId: 1 }], hotelDescription: "D1 住宿" },
    { day: 2, hotel: "日喀则酒店", hotelCandidates: [{ hotelId: 2 }], hotelDescription: "D2 住宿" },
  ];
  limitItineraryHotelStays(itinerary, 1);
  assert.deepEqual(itinerary, [
    { day: 1, hotel: "江孜酒店", hotelCandidates: [{ hotelId: 1 }], hotelDescription: "D1 住宿" },
    { day: 2, hotel: "无" },
  ]);
});

test("明确返回目的地住宿时不用当天最后的异地景点作为酒店锚点", () => {
  const day = {
    day: 1,
    title: "江孜游览后住日喀则",
    description: "下午游览白居寺，随后返回日喀则市区，入住当地4钻酒店。",
    hotel: "日喀则当地4钻酒店",
    spots: [{ name: "白居寺", city: "江孜" }],
  };
  assert.equal(hotelAnchorNameForDay(day, "日喀则"), "日喀则");
});

test("明确4钻时排除同城5钻候选", () => {
  const candidates = [
    { hotelId: 1, hotelName: "日喀则5钻", diamond: 5, score: 4.9, distanceKm: 1 },
    { hotelId: 2, hotelName: "日喀则4钻甲", diamond: 4, score: 4.8, distanceKm: 1.2 },
    { hotelId: 3, hotelName: "日喀则4钻乙", diamond: 4, score: 4.6, distanceKm: 2 },
  ];
  assert.deepEqual(
    hotelCandidatesForTier(candidates, "当地4钻酒店/-4").map((item) => item.hotelId),
    [2, 3],
  );
});

test("4天3晚保留前三个住宿日，只清除超过 nights 的送站日", () => {
  const itinerary = [
    { day: 1, hotel: "D1酒店" },
    { day: 2, hotel: "D2酒店" },
    { day: 3, hotel: "D3酒店" },
    { day: 4, hotel: "D4酒店" },
  ];
  limitItineraryHotelStays(itinerary, 3);
  assert.deepEqual(itinerary.map((day) => day.hotel), ["D1酒店", "D2酒店", "D3酒店", "无"]);
});

test("从携程 Next Flight 页面数据中提取酒店列表", () => {
  const data = JSON.stringify([1, 'J0:{"initListData":{"hotelList":[{"hotelInfo":{"summary":{"hotelId":"9"}}}]}}}']);
  const hotels = extractCtripHotelListFromHtml(`<script>self.__next_f.push(${data})</script>`);
  assert.equal((hotels[0] as { hotelInfo: { summary: { hotelId: string } } }).hotelInfo.summary.hotelId, "9");
});

test("携程酒店地标优先选择同城、可定位的末景点", () => {
  const context = selectCtripHotelContext([
    { id: "other", cityId: 30, cityName: "深圳", displayName: "晋祠", type: "Markland", gLat: 22.5, gLon: 113.9 },
    { id: "1619384", cityId: 105, cityName: "太原", displayName: "晋祠博物馆", type: "Markland", gLat: 37.7086, gLon: 112.4414 },
  ], { anchorName: "晋祠", preferredCity: "太原" });
  assert.equal(context.id, "1619384");
  assert.equal(context.cityId, 105);
});

test("携程地标的零值 gd 坐标会回退到有效的 g 坐标", () => {
  const context = selectCtripHotelContext([
    { id: "4197592", cityId: 105, cityName: "太原", displayName: "蒙山大佛", type: "Markland", gdLat: 0, gdLon: 0, gLat: 37.7826649, gLon: 112.4447887 },
  ], { anchorName: "蒙山大佛", preferredCity: "太原" });
  assert.deepEqual(context.coordinate, { latitude: 37.7826649, longitude: 112.4447887 });
});

test("酒店候选不设距离上限，按钻级、距离排序取最多五家", async () => {
  const hotel = (hotelId: number, name: string, star: number, score: number, latitude: number, longitude: number) => ({
    hotelInfo: {
      summary: { hotelId }, nameInfo: { name }, hotelStar: { star }, commentInfo: { commentScore: score },
      positionInfo: { cityName: "太原", address: `${name}地址`, mapCoordinate: [{ coordinateType: 1, latitude, longitude }] },
    },
  });
  const page = { evaluate: async () => [
    hotel(1, "近处5钻低分", 5, 4.5, 37.709, 112.442),
    hotel(2, "近处5钻高分", 5, 4.8, 37.710, 112.443),
    hotel(5, "第三家5钻", 5, 4.6, 37.712, 112.445),
    hotel(6, "第四家5钻", 5, 4.7, 37.713, 112.446),
    hotel(3, "近处4钻", 4, 4.9, 37.711, 112.444),
    hotel(4, "远处5钻", 5, 5, 39.9, 112.8),
  ] } as any;
  const candidates = await readCtripHotelCandidates(page, {
    id: "1619384", cityId: 105, cityName: "太原", name: "晋祠博物馆", coordinate: { latitude: 37.7086, longitude: 112.4414 },
  } as any);
  assert.deepEqual(candidates.map((item) => item.hotelId), [1, 2, 5, 6, 4]);
  assert.ok(candidates.some((item) => item.distanceKm > 30));
});

test("携程只返回一家有效酒店时仍允许继续", async () => {
  const page = { evaluate: async () => [{
    hotelInfo: {
      summary: { hotelId: 9 }, nameInfo: { name: "唯一可用酒店" }, hotelStar: { star: 4 }, commentInfo: { commentScore: 4.5 },
      positionInfo: { cityName: "太原", address: "远处地址", mapCoordinate: [{ coordinateType: 1, latitude: 38.9, longitude: 112.8 }] },
    },
  }] } as any;
  const candidates = await readCtripHotelCandidates(page, {
    id: "1619384", cityId: 105, cityName: "太原", name: "晋祠博物馆", coordinate: { latitude: 37.7086, longitude: 112.4414 },
  } as any);
  assert.deepEqual(candidates.map((item) => item.hotelId), [9]);
});

test("酒店列表 URL 保留携程城市、地标与入住日期，规划日期至少在未来", () => {
  const url = new URL(buildHotelListUrl({ cityId: 105, zoneId: "13764", checkin: "2026-12-01", checkout: "2026-12-02" }));
  assert.equal(url.searchParams.get("city"), "105");
  assert.equal(url.searchParams.get("zone"), "13764");
  assert.equal(url.searchParams.get("checkin"), "2026-12-01");
  const dates = nextHotelSearchDates(new Date("2026-09-03T12:00:00+08:00"));
  assert.equal(dates.checkin, "2026-12-02");
  assert.equal(dates.checkout, "2026-12-03");
});
