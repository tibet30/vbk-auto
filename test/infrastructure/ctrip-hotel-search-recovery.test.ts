import test from "node:test";
import assert from "node:assert/strict";
import {
  hotelSearchAnchorNames, hotelSearchContextCityForDay,
  resolveItineraryHotelCandidates,
} from "../../src/main/infrastructure/ctrip-hotel-search.js";

// Replays the failed product's lodging alias and day-2 POI, using the actual
// city split returned by Ctrip (青澳湾: 南澳县/21939, 汕头: 447).
const day = {
  day: 2, hotel: "潮汕当地5钻酒店", hotelDescription: "潮汕当地5钻酒店",
  description: "下午游览青澳湾，傍晚返回潮阳入住。",
  spots: [{ name: "青澳湾", poiName: "青澳湾", poiId: 83068, kind: "attraction" }],
};
const islandRows = [{ id: "4198990", cityId: 21939, cityName: "南澳县", word: "青澳湾",
  type: "Markland", gLat: 23.437711, gLon: 117.1352133 }];
const cityRows = [{ id: "4397754", cityId: 447, cityName: "汕头", word: "汕头小公园",
  type: "Markland", gLat: 23.3532952, gLon: 116.6737559 }];
const hotel = (hotelId: number, cityId: number, star: number) => ({ hotelInfo: {
  summary: { hotelId }, nameInfo: { name: `酒店${hotelId}` }, hotelStar: { star, starType: 0 },
  commentInfo: { commentScore: 4.8 }, positionInfo: {
    cityId, cityName: cityId === 447 ? "汕头" : "南澳县",
    mapCoordinate: [{ coordinateType: 1, latitude: 23.36, longitude: 116.68 }],
  },
} });

async function replay(contexts: unknown[], hotels: unknown[], run: (queries: string[]) => Promise<void>) {
  const originalFetch = globalThis.fetch;
  const queries: string[] = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.includes("gaHotelSearchEngine")) {
      const { keyword } = JSON.parse(String(init?.body));
      queries.push(keyword);
      return Response.json({ Response: { searchResults: keyword === "青澳湾" ? islandRows : contexts } });
    }
    const parsed = new URL(url);
    queries.push(`list:${parsed.searchParams.get("cityId")}`);
    const chunk = JSON.stringify([1, `J0:${JSON.stringify({ initListData: { hotelList: hotels } })}`]);
    return new Response(`<script>self.__next_f.push(${chunk})</script>`);
  };
  try { await run(queries); } finally { globalThis.fetch = originalFetch; }
}

test("区域住宿别名转换后保留城市兜底，不单独重试青澳湾", async () => {
  assert.equal(hotelSearchContextCityForDay(day, "潮汕"), "汕头");
  assert.deepEqual(hotelSearchAnchorNames(day, "潮汕"), ["青澳湾", "汕头"]);
  await replay(cityRows, [hotel(1, 447, 5), hotel(2, 21939, 5), hotel(3, 447, 4)], async (queries) => {
    const result = await resolveItineraryHotelCandidates([day], "潮汕", 4, "当地5钻酒店/-38");
    assert.deepEqual(queries, ["青澳湾", "汕头", "list:447"]);
    assert.deepEqual(result.dailyCandidates[0]?.candidates.map((item) => item.hotelId), [1]);
    assert.equal(result.itinerary[0]?.hotel, "酒店1");
    assert.equal(day.hotel, "潮汕当地5钻酒店");
    assert.match(String(result.itinerary[0]?.hotelDescription), /汕头小公园/);
  });
});

test("末景点带明确城市但没有住宿城市文本时也能同城兜底", () => {
  assert.deepEqual(hotelSearchAnchorNames({ hotel: "当地5钻酒店",
    spots: [{ name: "青澳湾", city: "汕头", kind: "attraction" }],
  }, "潮汕"), ["青澳湾", "汕头"]);
});

test("城市兜底仍为异地结果时阻断，错误包含住宿日与钻级", async () => {
  await replay(islandRows, [], async (queries) => {
    await assert.rejects(resolveItineraryHotelCandidates([day], "潮汕", 4, "当地5钻酒店/-38"),
      /第 2 天住宿（检索城市：汕头，要求：当地5钻）未完成：携程未找到汕头内/);
    assert.deepEqual(queries, ["青澳湾", "汕头"]);
  });
});

test("城市兜底找到酒店但只有4钻时保留5钻约束", async () => {
  await replay(cityRows, [hotel(1, 447, 4)], async () => {
    await assert.rejects(resolveItineraryHotelCandidates([day], "潮汕", 4, "当地5钻酒店/-38"),
      /第 2 天住宿.*尚未取得符合当地5钻要求/);
  });
});
