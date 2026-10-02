import assert from "node:assert/strict";
import test from "node:test";
import { extraPreparationGaps } from "../../src/main/planning/preparation-checks.js";

test("2天1晚只要求真实住宿日的携程酒店候选", () => {
  const product = {
    basicInfo: { meetingCity: "泸州", destinationCity: "泸州", days: 2, nights: 1 },
    itinerary: [
      { day: 1, hotel: "泸州市区当地5钻酒店" },
      { day: 2, hotel: "当日行程结束，不安排过夜住宿。" },
    ],
  };
  const missing = extraPreparationGaps(product).map((gap) => gap.label);
  assert.ok(missing.includes("酒店候选：第 1 天"));
  assert.ok(!missing.includes("酒店候选：第 2 天"));
});

test("酒店候选必须含携程ID和与已锁定档次一致的可验证字段", () => {
  const candidate = {
    hotelId: 101, hotelName: "潮州腾瑞皇冠假日酒店", diamond: 5, score: 4.8,
    distanceKm: 2.4, cityName: "潮州", anchorName: "潮州古城", anchorCityId: 215,
  };
  const product = {
    basicInfo: { meetingCity: "潮州", destinationCity: "潮州", days: 2, nights: 1 },
    operations: { hotelTier: "当地5钻酒店/-38" },
    itinerary: [{ day: 1, hotel: "潮州当地5钻酒店", hotelCandidates: [candidate, { ...candidate, hotelId: 102 }, { ...candidate, hotelId: 103 }] }],
  };
  assert.ok(!extraPreparationGaps(product).some((gap) => gap.label === "酒店候选：第 1 天"));

  const fake = structuredClone(product);
  (fake.itinerary[0]!.hotelCandidates[0] as Record<string, unknown>).hotelId = undefined;
  assert.ok(extraPreparationGaps(fake).some((gap) => gap.label === "酒店候选：第 1 天"));

  const wrongTier = structuredClone(product);
  (wrongTier.itinerary[0]!.hotelCandidates[0] as Record<string, unknown>).diamond = 4;
  assert.ok(extraPreparationGaps(wrongTier).some((gap) => gap.label === "酒店候选：第 1 天"));

  for (const [field, value] of [["score", null], ["distanceKm", ""], ["score", Number.NaN], ["diamond", "5"]] as const) {
    const invalidNumber = structuredClone(product);
    (invalidNumber.itinerary[0]!.hotelCandidates[0] as Record<string, unknown>)[field] = value;
    assert.ok(extraPreparationGaps(invalidNumber).some((gap) => gap.label === "酒店候选：第 1 天"), `${field}=${String(value)} must be rejected`);
  }
});
