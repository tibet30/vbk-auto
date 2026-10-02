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
  hotelSearchAnchorNames,
  hotelCandidatesForTier,
  shouldResolveItineraryHotelForDay,
} from "../../src/main/infrastructure/ctrip-hotel-search.js";
import { hasItineraryHotelStay } from "../../src/shared/itinerary-hotel.js";

test("送站日的酒店“无”不会进入酒店候选检索", () => {
  assert.equal(hasItineraryHotelStay("无"), false);
  assert.equal(hasItineraryHotelStay("维也纳酒店"), true);
});

test("空酒店字段会按产品 nights 进入携程行程酒店解析", () => {
  assert.equal(shouldResolveItineraryHotelForDay({ day: 1, hotel: "" }, 0, 1), true);
  assert.equal(shouldResolveItineraryHotelForDay({ day: 2, hotel: "" }, 1, 1), false);
  assert.equal(shouldResolveItineraryHotelForDay({ day: 1, hotel: "无" }, 0, 1), false);
  assert.equal(shouldResolveItineraryHotelForDay({ day: 1, hotel: "维也纳酒店" }, 0, 0), true);
  assert.equal(shouldResolveItineraryHotelForDay({ day: 2, hotel: "当日行程结束，不安排过夜住宿。" }, 1, 1), false);
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

test("明确末日不住宿时保留原文，不制造第二晚酒店", () => {
  const itinerary = [
    { day: 1, hotel: "泸州市区当地5钻酒店" },
    { day: 2, hotel: "当日行程结束，不安排过夜住宿。" },
  ];
  limitItineraryHotelStays(itinerary, 1);
  assert.equal(itinerary[1]!.hotel, "当日行程结束，不安排过夜住宿。");
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
  assert.deepEqual(hotelSearchAnchorNames(day, "日喀则"), ["日喀则"]);
});

test("出发城市不是住宿城市时不把出发地当作酒店锚点", () => {
  const day = {
    title: "南澳海岛环岛一日",
    description: "从潮州出发经南澳大桥登岛，当晚入住南澳岛酒店。",
    hotel: "南澳岛当地5钻酒店",
  };
  assert.equal(hotelAnchorNameForDay(day, "潮州"), "");
});

test("住宿城市明确且末景点同城时先用景点定位，城市只作兜底", () => {
  assert.deepEqual(hotelSearchAnchorNames({
    hotel: "泸州市区当地5钻酒店",
    spots: [{ name: "忠山公园", poiName: "忠山公园" }],
  }, "泸州"), ["忠山公园", "泸州"]);
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

test("当前候选没有指定钻级时不把单页结果断言为当地无房", () => {
  assert.throws(
    () => hotelCandidatesForTier([{ hotelId: 1, hotelName: "四钻酒店", diamond: 4, score: 4.8, distanceKm: 1 }], "当地5钻酒店/-38"),
    /不能据此断定当地没有该档次酒店/,
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

test("只有异地酒店地标时停止，不把异地酒店绑定到目标城市", () => {
  assert.throws(() => selectCtripHotelContext([
    { id: "other", cityId: 30, cityName: "深圳市", displayName: "金龙寺", type: "Markland", gLat: 22.5, gLon: 113.9 },
  ], { anchorName: "泸州", preferredCity: "泸州", requirePreferredCity: true }), /泸州内/);
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
      summary: { hotelId }, nameInfo: { name }, hotelStar: { star, starType: 0 }, commentInfo: { commentScore: score },
      positionInfo: { cityId: 105, cityName: "太原", address: `${name}地址`, mapCoordinate: [{ coordinateType: 1, latitude, longitude }] },
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

test("先按指定钻级筛选再截取五家，避免高钻结果挤掉目标档次", async () => {
  const hotel = (hotelId: number, star: number) => ({ hotelInfo: {
    summary: { hotelId }, nameInfo: { name: `酒店${hotelId}` }, hotelStar: { star, starType: 0 },
    commentInfo: { commentScore: 4.5 },
    positionInfo: { cityId: 100, cityName: "泸州", mapCoordinate: [{ coordinateType: 1, latitude: 28.9, longitude: 105.4 }] },
  } });
  const page = { evaluate: async () => [
    ...Array.from({ length: 6 }, (_, index) => hotel(index + 1, 5)), hotel(7, 3),
  ] } as any;
  const anchor = { id: "anchor", cityId: 100, cityName: "泸州", name: "金龙寺", coordinate: { latitude: 28.9, longitude: 105.4 } } as any;
  assert.deepEqual((await readCtripHotelCandidates(page, anchor, "当地3钻酒店/-3")).map((item) => item.hotelId), [7]);
});

test("携程只返回一家有效酒店时仍允许继续", async () => {
  const page = { evaluate: async () => [{
    hotelInfo: {
      summary: { hotelId: 9 }, nameInfo: { name: "唯一可用酒店" }, hotelStar: { star: 4, starType: 0 }, commentInfo: { commentScore: 4.5 },
      positionInfo: { cityId: 105, cityName: "太原", address: "远处地址", mapCoordinate: [{ coordinateType: 1, latitude: 38.9, longitude: 112.8 }] },
    },
  }] } as any;
  const candidates = await readCtripHotelCandidates(page, {
    id: "1619384", cityId: 105, cityName: "太原", name: "晋祠博物馆", coordinate: { latitude: 37.7086, longitude: 112.4414 },
  } as any);
  assert.deepEqual(candidates.map((item) => item.hotelId), [9]);
});

test("酒店城市必须与官方锚点城市 ID 一致，缺失城市 ID 也拒绝", async () => {
  const hotel = (hotelId: number, cityId?: number) => ({ hotelInfo: {
    summary: { hotelId }, nameInfo: { name: `酒店${hotelId}` }, hotelStar: { star: 5, starType: 0 },
    commentInfo: { commentScore: 4.5 },
    positionInfo: { ...(cityId ? { cityId } : {}), cityName: cityId === 447 ? "汕头" : "潮州", mapCoordinate: [{ coordinateType: 1, latitude: 23.66, longitude: 116.66 }] },
  } });
  const page = { evaluate: async () => [hotel(1, 215), hotel(2, 447), hotel(3)] } as any;
  const anchor = { id: "anchor", cityId: 215, cityName: "潮州", name: "潮州古城", coordinate: { latitude: 23.66, longitude: 116.66 } } as any;
  assert.deepEqual((await readCtripHotelCandidates(page, anchor, "当地5钻酒店/-38")).map((item) => item.hotelId), [1]);
});

test("当地钻级不接受携程星级酒店或民宿圆钻", async () => {
  const hotel = (hotelId: number, starType: number) => ({ hotelInfo: {
    summary: { hotelId }, nameInfo: { name: `酒店${hotelId}` }, hotelStar: { star: 5, starType },
    commentInfo: { commentScore: 4.5 },
    positionInfo: { cityId: 215, cityName: "潮州", mapCoordinate: [{ coordinateType: 1, latitude: 23.66, longitude: 116.66 }] },
  } });
  const page = { evaluate: async () => [hotel(1, 0), hotel(2, 1), hotel(3, 2)] } as any;
  const anchor = { id: "anchor", cityId: 215, cityName: "潮州", name: "潮州古城", coordinate: { latitude: 23.66, longitude: 116.66 } } as any;
  assert.deepEqual((await readCtripHotelCandidates(page, anchor, "当地5钻酒店/-38")).map((item) => item.hotelId), [1]);
});

test("酒店列表 URL 保留携程城市、地标与入住日期，规划日期至少在未来", () => {
  const url = new URL(buildHotelListUrl({ cityId: 105, zoneId: "13764", checkin: "2026-12-01", checkout: "2026-12-02" }));
  assert.equal(url.searchParams.get("city"), "105");
  assert.equal(url.searchParams.get("zone"), "13764");
  assert.equal(url.searchParams.get("checkin"), "2026-12-01");
  const filtered = new URL(buildHotelListUrl({ cityId: 215, cityName: "潮州", checkin: "2026-12-01", checkout: "2026-12-02", hotelTier: "当地5钻酒店/-38" }));
  assert.equal(filtered.searchParams.get("cityId"), "215");
  assert.equal(filtered.searchParams.get("listFilters"), "29~1*29*1~1*2,17~1*17*1,16~5*16*5,80~2*80*2");
  const dates = nextHotelSearchDates(new Date("2026-09-03T12:00:00+08:00"));
  assert.equal(dates.checkin, "2026-12-02");
  assert.equal(dates.checkout, "2026-12-03");
});
