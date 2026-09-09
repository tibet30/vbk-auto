import test from "node:test";
import assert from "node:assert/strict";
import { estimateCommercialPricing } from "../../src/main/planning/commercial-stage.js";

test("私家团缺失报价时按酒店、专车和讲解密度计算可审核指导价", () => {
  const pricing = estimateCommercialPricing(
    {
      destination: "日喀则", days: 2, nights: 1, productForm: "privateTour",
      productType: "domesticShort", supplierProductCode: "NEW",
    },
    {
      operations: { hotelTier: "当地4钻酒店/-4", transport: "charter" },
      itinerary: [
        { description: "三个景点均配讲解", spots: [{ poiId: 1 }, { poiId: 2 }, { poiId: 3 }] },
        // 同一 POI 的重复 alternatives 不能把讲解成本重复计算。
        { description: "博物馆与寺院均配讲解", spots: [{ poiId: 4 }, { poiId: 4 }, { poiId: 5 }] },
      ],
    },
  ) as { adult: number; child: number; minimumTravelers: number; cost: Record<string, number> };

  assert.deepEqual(pricing, {
    adult: 1880,
    child: 980,
    minimumTravelers: 1,
    currency: "CNY",
    cost: { adult: 1500, child: 700, singleSupplement: 370, childBed: 290 },
  });
});
