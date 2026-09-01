import assert from "node:assert/strict";
import test from "node:test";
import { enrichItineraryPoiMetadata } from "../../src/main/automation/ctrip/itinerary-api/poi-metadata.js";

test("行程 POI 元数据接受平台以字符串返回的枚举 key", async () => {
  const page = {
    async evaluate<T>() {
      return {
        status: 200,
        payload: {
          poiList: [{ poiId: 149958711, poiType: { key: "3", name: "景点" }, ticketType: { key: "2", name: "免费" } }],
        },
        durationMs: 1,
        ctx: {},
      } as T;
    },
  };
  const [day] = await enrichItineraryPoiMetadata(page, [{ day: 1, spots: [{ poiId: 149958711, poiName: "鼓楼" }] }]);
  assert.deepEqual(day.spots?.[0]?.poiType, { key: 3, name: "景点" });
  assert.deepEqual(day.spots?.[0]?.ticketType, { key: 2, name: "免费" });
});
