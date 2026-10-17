import test from "node:test";
import assert from "node:assert/strict";
import { applyAutoCoverFill } from "../../src/main/operations/cover-auto-fill.js";

function coverProduct(description: string) {
  return {
    sales: { productType: "domesticShort", productForm: "privateTour", splitGroup: false },
    basicInfo: {
      supplierProductName: "拉萨7天6晚私家团",
      subtitle: "一单一团+24h线上管家",
      days: 7,
      nights: 6,
      meetingCity: "拉萨",
      destinationCity: "拉萨",
      province: "西藏",
      operationNotes: "高海拔线路",
    },
    presentation: {
      recommendation: "阿里南线冰川主题线路",
      features: "<p>冰川主题</p>",
      cover: {
        source: "ctripLibrary",
        poi: "羊卓雍错",
        description,
        minQuality: 3,
      },
    },
    operations: { transport: "charter", pickupCity: "拉萨" },
    itinerary: [{
      day: 1,
      title: "洛子峰",
      spots: [{ name: "洛子峰", poiName: "洛子I峰", poiId: 85087 }],
    }],
  };
}

async function replaceCover(description: string) {
  const product = coverProduct(description);

  return applyAutoCoverFill({
    page: {} as never,
    product,
    now: () => "2026-10-16T00:00:00.000Z",
    injectSearch: async (_page, keyword) => ({
      keyword,
      poi: "",
      fetchedAt: "2026-10-16T00:00:00.000Z",
      candidates: keyword === "洛子I峰" || keyword === "洛子峰" ? [{
        stableId: "85087-1",
        index: 0,
        quality: "3.2",
        resolution: "2400*1600",
        imageId: 26753034,
        imageUrl: "https://example.test/lotse.jpg",
        imageResolved: true,
        poiId: 85087,
        poiName: "洛子I峰",
        score: 3.2,
      }] : [],
    }),
  });
}

test("图库主图切换景点时同步封面说明，避免保留旧景点文案", async () => {
  const result = await replaceCover("羊卓雍错代表性横版封面图");

  const cover = (result.nextProduct.presentation as Record<string, unknown>).cover as Record<string, unknown>;
  assert.equal(cover.poi, "洛子I峰");
  assert.equal(cover.description, "洛子I峰");
});

test("图库主图切换景点时保留不依赖旧景点的通用封面说明", async () => {
  const result = await replaceCover("高原雪山主题横版封面图");

  const cover = (result.nextProduct.presentation as Record<string, unknown>).cover as Record<string, unknown>;
  assert.equal(cover.poi, "洛子I峰");
  assert.equal(cover.description, "高原雪山主题横版封面图");
});
