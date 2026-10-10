import test from "node:test";
import assert from "node:assert/strict";
import { resolveItineraryHotelCandidates, buildHotelListUrl } from "../../src/main/infrastructure/ctrip-hotel-search.js";
import { mergeResolvedHotelProgress } from "../../src/main/agent/integration-itinerary-hotel-result.js";

test("3/4钻也使用已核验官方筛选", () => {
  for (const tier of [3, 4]) {
    const url = new URL(buildHotelListUrl({ cityId: 21367, cityName: "留坝", checkin: "2027-01-04", checkout: "2027-01-05", hotelTier: `当地${tier}钻酒店` }));
    assert.match(url.searchParams.get("listFilters")!, new RegExp(`16~${tier}\\*16\\*${tier}`));
  }
});

test("中间一天失败仍核验其余日期并逐日保存，重试只查询缺失日期", async () => {
  const initial = [1, 2, 3].map(day => ({ day, hotel: "留坝县当地3钻酒店", hotelDescription: "留坝县当地3钻酒店", description: "原始说明", spots: [] }));
  let saved: Record<string, unknown> = { itinerary: initial, operations: {} };
  const originalFetch = globalThis.fetch;
  let listCalls = 0;
  let failMiddle = true;
  globalThis.fetch = async (input) => {
    if (String(input).includes("gaHotelSearchEngine")) return Response.json({ Response: { searchResults: [
      { id: "anchor", cityId: 21367, cityName: "留坝", word: "留坝县", gLat: 33.6, gLon: 106.9 },
    ] } });
    listCalls++;
    const hotelList = listCalls === 2 && failMiddle ? [] : [{ hotelInfo: {
      summary: { hotelId: 100 + listCalls }, nameInfo: { name: `留坝酒店${listCalls}` }, hotelStar: { star: 3, starType: 0 },
      commentInfo: { commentScore: 4.8 }, positionInfo: { cityId: 21367, cityName: "留坝", mapCoordinate: [{ latitude: 33.6, longitude: 106.9, coordinateType: 1 }] },
    } }];
    return new Response(`<script>self.__next_f.push(${JSON.stringify([1, JSON.stringify({ initListData: { hotelList } })])})</script>`);
  };
  try {
    await assert.rejects(resolveItineraryHotelCandidates(initial, "留坝", 3, "当地3钻酒店", progress => {
      // 模拟真实持久化入口，查询期间另一字段的修改必须保留。
      const days = saved.itinerary as typeof initial;
      days[0] = { ...days[0], description: "人工更新说明" };
      saved = mergeResolvedHotelProgress(saved, initial, progress);
    }), /已取得 2 天.*\n第 2 天住宿/s);
    assert.equal(listCalls, 3);
    const days = saved.itinerary as Array<Record<string, unknown>>;
    assert.equal(days[0].description, "人工更新说明");
    assert.equal((days[0].hotelCandidates as unknown[]).length, 1);
    assert.equal(days[1].hotelCandidates, undefined);
    assert.equal((days[2].hotelCandidates as unknown[]).length, 1);
    failMiddle = false;
    const retry = await resolveItineraryHotelCandidates(days, "留坝", 3, "当地3钻酒店");
    assert.equal(listCalls, 4);
    assert.equal(retry.dailyCandidates.length, 3);
  } finally { globalThis.fetch = originalFetch; }
});
