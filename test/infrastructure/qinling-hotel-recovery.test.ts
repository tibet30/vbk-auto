import test from "node:test";
import assert from "node:assert/strict";
import { hotelSearchContextCityForDay, hotelSearchAnchorNames, resolveItineraryHotelCandidates, selectCtripHotelContext } from "../../src/main/infrastructure/ctrip-hotel-search.js";

const itinerary = [
  { day: 1, hotel: "眉县太白山唐镇内度假酒店（双人标准间，含温泉体验）", spots: [{ name: "眉县太白山唐镇", kind: "other" }] },
  { day: 2, hotel: "太白县咀头镇当地5钻酒店", spots: [{ name: "黄柏塬原始森林景区", kind: "attraction", poiId: 148644799 }] },
  { day: 3, hotel: "留坝县留侯镇当地5钻酒店", spots: [{ name: "张良庙", kind: "attraction", poiId: 79410 }] },
  { day: 4, hotel: "洋县华阳古镇内特色客栈", spots: [{ name: "秦岭四宝园", kind: "attraction", poiId: 145272436 }] },
  { day: 5, hotel: "汉中市汉台区中心广场附近5钻酒店", spots: [{ name: "佛坪熊猫谷旅游区", kind: "attraction", poiId: 22883772 }] },
  { day: 6, hotel: "无当日住宿安排", spots: [{ name: "汉中站", kind: "other" }] },
];

test("逐晚使用明确住宿市县和落脚点，不回退西安或误用途经景点", () => {
  assert.deepEqual(itinerary.slice(0, 5).map((day) => hotelSearchContextCityForDay(day, "西安")), ["眉", "太白", "留坝", "洋", "汉中"]);
  assert.deepEqual(itinerary.slice(0, 5).map((day) => hotelSearchAnchorNames(day, "西安")[0]),
    ["眉县太白山唐镇", "太白县咀头镇", "留坝县留侯镇", "洋县华阳古镇", "汉中市汉台区中心广场"]);
});

test("县市前缀不匹配时保留当地地标别名，仍拒绝异地返回", () => {
  assert.deepEqual(hotelSearchAnchorNames(itinerary[2]!, "西安"), ["留坝县留侯镇", "留坝留侯镇", "留侯镇", "留坝"]);
  assert.deepEqual(hotelSearchAnchorNames(itinerary[4]!, "西安"), ["汉中市汉台区中心广场", "汉中中心广场", "中心广场", "汉中"]);
  const rows = [
    { id: "other", cityId: 129, cityName: "汉中", word: "留侯镇", gLat: 33, gLon: 107 },
    { id: "local", cityId: 21367, cityName: "留坝", word: "留侯镇人民政府", gLat: 33.69, gLon: 106.85 },
  ];
  assert.equal(selectCtripHotelContext(rows, { anchorName: "留侯镇", preferredCity: "留坝", requirePreferredCity: true }).id, "local");
});

test("重放五晚酒店查询，按官方城市ID筛选，跳过送站日并保留原始POI", async () => {
  const original = structuredClone(itinerary);
  const originalFetch = globalThis.fetch;
  const cities = ["眉县", "太白县", "留坝县", "洋县", "汉中"];
  const anchors = itinerary.slice(0, 5).map((day) => hotelSearchAnchorNames(day, "西安")[0]);
  const queries: string[] = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.includes("gaHotelSearchEngine")) {
      const { keyword } = JSON.parse(String(init?.body));
      queries.push(keyword);
      const index = anchors.indexOf(keyword);
      assert.ok(index >= 0, `unexpected query ${keyword}`);
      return Response.json({ Response: { searchResults: [{ id: `anchor-${index}`, cityId: index + 100,
        cityName: cities[index], word: keyword, type: "Markland", gLat: 33, gLon: 107 }] } });
    }
    const cityId = Number(new URL(url).searchParams.get("cityId"));
    const hotelList = [cityId, 999].map((id) => ({ hotelInfo: {
      summary: { hotelId: id }, nameInfo: { name: `核验酒店${id}` }, hotelStar: { star: 5, starType: 0 },
      commentInfo: { commentScore: 4.8 }, positionInfo: { cityId: id, cityName: cities[cityId - 100],
        mapCoordinate: [{ coordinateType: 1, latitude: 33, longitude: 107 }] },
    } }));
    const chunk = JSON.stringify([1, `J0:${JSON.stringify({ initListData: { hotelList } })}`]);
    return new Response(`<script>self.__next_f.push(${chunk})</script>`);
  };
  try {
    const result = await resolveItineraryHotelCandidates(itinerary, "西安", 5, "当地5钻酒店/-38");
    assert.deepEqual(queries, anchors);
    assert.equal(result.dailyCandidates.length, 5);
    assert.deepEqual(result.dailyCandidates.map((day) => day.candidates.map((candidate) => candidate.hotelId)), [[100], [101], [102], [103], [104]]);
    assert.equal(result.itinerary[5]?.hotel, "无当日住宿安排");
    assert.deepEqual(result.itinerary.map((day) => day.spots), original.map((day) => day.spots));
    assert.deepEqual(itinerary, original);
  } finally { globalThis.fetch = originalFetch; }
});
