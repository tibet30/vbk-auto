import test from "node:test";
import assert from "node:assert/strict";
import { reusableHotelCandidatesFromPool } from "../../src/main/infrastructure/ctrip-hotel-candidate-cache.js";
import { mergeResolvedHotelProgress } from "../../src/main/agent/integration-itinerary-hotel-result.js";
import { hotelStayRequirement } from "../../src/shared/hotel-stay-requirement.js";

const candidate = { hotelId: 101, hotelName: "测试酒店", diamond: 5, score: 4.8, cityName: "杭州", anchorName: "西湖", anchorCityId: 1, distanceKm: 1 };

test("原始逐晚评级在第一次搜索前生效，已确认的新评级优先", () => {
  const product = { basicInfo: { userIdea: "第1晚西湖5钻酒店，第2晚古镇3钻民宿" } };
  const day = { day: 2, hotel: "古镇民宿", hotelRequirement: { anchorName: "古镇" } };
  assert.equal(hotelStayRequirement(product, day)?.diamond, 3);
  assert.equal(hotelStayRequirement(product, day)?.ratingType, "homestay");
  const latest = { ...day, hotelRequirement: { anchorName: "古镇", diamond: 4, ratingType: "diamond" } };
  assert.equal(hotelStayRequirement(product, latest)?.diamond, 4);
  assert.equal(hotelStayRequirement(product, latest)?.ratingType, "diamond");
});

test("没有距离范围或城市信息的跨产品缓存仍必须匹配住宿地点", () => {
  assert.equal(reusableHotelCandidatesFromPool([candidate], "当地5钻酒店", { anchorName: "宁波" }), undefined);
  assert.equal(reusableHotelCandidatesFromPool([candidate], "当地5钻酒店"), undefined);
  assert.deepEqual(reusableHotelCandidatesFromPool([candidate], "当地5钻酒店", { anchorName: "杭州" }), [candidate]);
});

test("酒店进度字段顺序变化不算修改，真实评级变化仍拒绝", () => {
  const initial = [{ day: 1, hotel: "测试酒店", hotelRequirement: { anchorName: "西湖", cityName: "杭州", diamond: 5 } }];
  const product = { itinerary: [{ ...initial[0], hotelRequirement: { diamond: 5, cityName: "杭州", anchorName: "西湖" } }] };
  const receipt = { itinerary: initial, dailyCandidates: [{ day: 1, candidates: [candidate] }], searchDates: { checkin: "2026-12-01", checkout: "2026-12-02" } };
  assert.doesNotThrow(() => mergeResolvedHotelProgress(product, initial, receipt));
  product.itinerary[0]!.hotelRequirement.diamond = 4;
  assert.throws(() => mergeResolvedHotelProgress(product, initial, receipt), /查询期间已改变/);
});
