/** applyAutoCoverFill 主流程：跳过、写回、POI 归属校验、无图停下、manualUpload 保护。 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  applyAutoCoverFill,
  collectCoverSearchKeywords,
} from "../../src/main/operations/cover-auto-fill.js";
import { makeBaseProduct } from "./cover-auto-fill-fixtures.js";

test("applyAutoCoverFill: cover 已准备满目标张数时直接跳过，不发请求", async () => {
  const product = makeBaseProduct({
    presentation: {
      recommendation: "推荐语",
      features: "产品特点",
      cover: {
        source: "ctripLibrary",
        poi: "云冈石窟",
        description: "横版",
        minQuality: 3,
        imageId: 1,
        imageUrl: "https://img",
        // 1 主图 + 9 备图 = 10 张，达到 COVER_IMAGE_TARGET_COUNT 上限 → 跳过补齐。
        alternates: Array.from({ length: 9 }, (_, index) => ({
          imageId: 100 + index,
          imageUrl: `https://img/${100 + index}`,
          poi: index === 0 ? "晋祠" : "云冈石窟",
        })),
      },
    },
  });
  let called = 0;
  const page = {
    evaluate: async () => {
      called += 1;
      return { status: 200, durationMs: 1, ctx: { hasCid: true, cookieNameCount: 1, hasGuidCookie: true, hasVbkLoginCidCookie: false }, payload: {} };
    },
  };
  const result = await applyAutoCoverFill({ page: page as never, product });
  assert.equal(result.outcome.written, false);
  assert.match(result.outcome.reason, /已准备/);
  assert.equal(called, 0);
});

test("applyAutoCoverFill: cover 缺 imageId 时按 cover.poi 搜一次并写入完整 cover", async () => {
  const product = makeBaseProduct();
  // 注入 search：直接返回一条 imageResolved=true 的完整候选，覆盖
  // 「真实成功写回」路径；不再 fake Ctrip 整个网络栈。
  const result = await applyAutoCoverFill({
    page: {} as never,
    product,
    now: () => "2026-08-12T00:00:00.000Z",
    injectSearch: async () => ({
      keyword: "云冈石窟",
      poi: "",
      fetchedAt: "2026-08-12T00:00:00.000Z",
      candidates: [
        {
          stableId: "c1",
          index: 0,
          quality: "4.5",
          resolution: "1920*1080",
          imageId: 111,
          imageUrl: "https://img",
          imageResolved: true,
          poiId: 99,
          poiName: "云冈石窟",
          score: 4.5,
          previewUrl: "https://preview",
          thumbnailUrl: "https://thumb",
        },
      ],
    }),
  });
  assert.equal(result.outcome.written, true);
  assert.match(result.outcome.reason, /已写入/);
  assert.equal(result.outcome.keyword, "云冈石窟");
  assert.equal(result.outcome.imageId, 111);
  // nextProduct 与 product 不同；presentation.cover 被覆盖。
  assert.notEqual(result.nextProduct, product);
  const nextCover = ((result.nextProduct.presentation as Record<string, unknown>).cover) as Record<string, unknown>;
  assert.equal(nextCover.source, "ctripLibrary");
  assert.equal(nextCover.imageId, 111);
  assert.equal(nextCover.imageUrl, "https://img");
  assert.equal(nextCover.poi, "云冈石窟");
  assert.equal(nextCover.description, "云冈石窟 1");
  assert.equal(nextCover.minQuality, 3);
  assert.equal(nextCover.selectedAt, "2026-08-12T00:00:00.000Z");
  assert.equal(nextCover.score, 4.5);
});

test("applyAutoCoverFill: 从不同景点各准备一张图，主图后写入备用候选", async () => {
  const product = makeBaseProduct({
    presentation: {
      recommendation: "推荐语",
      features: "产品特点",
      cover: { source: "ctripLibrary", poi: "", description: "d", minQuality: 3 },
    },
    itinerary: [
      { day: 1, title: "太原", spots: [{ name: "晋祠" }] },
      { day: 2, title: "云冈石窟", spots: [{ name: "云冈石窟" }] },
      { day: 3, title: "平遥", spots: [{ name: "平遥古城" }] },
    ],
  });
  const result = await applyAutoCoverFill({
    page: {} as never,
    product,
    now: () => "2026-08-12T00:00:00.000Z",
    injectSearch: async (_page, keyword) => ({
      keyword,
      poi: "",
      fetchedAt: "2026-08-12T00:00:00.000Z",
      candidates: [
        {
          stableId: keyword,
          index: 0,
          quality: "4.5",
          resolution: "1920*1080",
          imageId: keyword === "晋祠" ? 111 : keyword === "云冈石窟" ? 222 : 333,
          imageUrl: `https://img/${keyword}`,
          imageResolved: true,
          poiName: keyword,
        },
      ],
    }),
  });
  assert.equal(result.outcome.written, true);
  assert.deepEqual(result.outcome.imageIds, [111, 222, 333]);
  const nextCover = ((result.nextProduct.presentation as Record<string, unknown>).cover) as Record<string, unknown>;
  assert.equal(nextCover.imageId, 111);
  assert.deepEqual(
    (nextCover.alternates as Array<Record<string, unknown>>).map((item) => [item.poi, item.imageId]),
    [["云冈石窟", 222], ["平遥古城", 333]],
  );
});

test("applyAutoCoverFill: rejects a complete image that belongs to another POI", async () => {
  const product = makeBaseProduct({
    itinerary: [{ day: 1, title: "太原出发", spots: [{ name: "晋祠", poiName: "晋祠", poiId: 1 }] }],
    presentation: { recommendation: "推荐语", features: "产品特点", cover: { source: "ctripLibrary", poi: "晋祠" } },
  });
  const result = await applyAutoCoverFill({
    page: {} as never,
    product,
    injectSearch: async () => ({
      keyword: "晋祠", poi: "", fetchedAt: "2026-08-12T00:00:00.000Z",
      candidates: [{ stableId: "wrong", index: 0, quality: "4.5", resolution: "1920*1080", imageId: 111, imageUrl: "https://img", imageResolved: true, poiId: 2, poiName: "大益庄园" }],
    }),
  });
  assert.equal(result.outcome.written, false);
  assert.equal((result.nextProduct.presentation as Record<string, unknown>).coverFallback, undefined);
});

test("applyAutoCoverFill: rejects nameless candidates when itinerary already has bound POI IDs", async () => {
  const product = makeBaseProduct({
    itinerary: [{ day: 1, title: "太原出发", spots: [{ name: "晋祠", poiName: "晋祠", poiId: 1 }] }],
    presentation: { recommendation: "推荐语", features: "产品特点", cover: { source: "ctripLibrary", poi: "晋祠" } },
  });
  const result = await applyAutoCoverFill({
    page: {} as never,
    product,
    injectSearch: async () => ({
      keyword: "晋祠", poi: "", fetchedAt: "2026-08-12T00:00:00.000Z",
      candidates: [{ stableId: "nameless", index: 0, quality: "4.5", resolution: "1920*1080", imageId: 222, imageUrl: "https://img", imageResolved: true }],
    }),
  });
  assert.equal(result.outcome.written, false);
  assert.equal((result.nextProduct.presentation as Record<string, unknown>).coverFallback, undefined);
});

test("applyAutoCoverFill: search 抛错时停下提示重试，不写占位图", async () => {
  const product = makeBaseProduct();
  const page = {
    evaluate: async () => {
      throw new Error("simulated vbk offline");
    },
  };
  const result = await applyAutoCoverFill({ page: page as never, product });
  assert.equal(result.outcome.written, false);
  assert.match(result.outcome.reason, /失败.*请重试或人工上传\/选择图库图片/);
  assert.equal(result.nextProduct, product);
  assert.equal((product.presentation as Record<string, unknown>).coverFallback, undefined);
});

test("applyAutoCoverFill: manualUpload cover 永不覆盖", async () => {
  const product = makeBaseProduct({
    presentation: {
      recommendation: "推荐语",
      features: "产品特点",
      cover: {
        source: "manualUpload",
        fileId: "abc",
        originalName: "cover.jpg",
        mimeType: "image/jpeg",
        sizeBytes: 1024,
        poi: "云冈石窟",
        description: "上传封面",
        minQuality: 3,
        uploadedAt: "2026-08-01T00:00:00.000Z",
      },
    },
  });
  let called = 0;
  const page = {
    evaluate: async () => {
      called += 1;
      return { status: 200, durationMs: 1, ctx: { hasCid: true, cookieNameCount: 1, hasGuidCookie: true, hasVbkLoginCidCookie: false }, payload: {} };
    },
  };
  const result = await applyAutoCoverFill({ page: page as never, product });
  assert.equal(result.outcome.written, false);
  assert.match(result.outcome.reason, /manualUpload/);
  assert.equal(called, 0);
  assert.equal(result.nextProduct, product);
});

test("applyAutoCoverFill: cover 缺 description 仍按景点 POI 选图", async () => {
  const product = makeBaseProduct({
    presentation: {
      recommendation: "推荐语",
      features: "产品特点",
      cover: { source: "ctripLibrary", poi: "云冈石窟", description: "", minQuality: 3 },
    },
  });
  const result = await applyAutoCoverFill({
    page: {} as never,
    product,
    injectSearch: async () => ({
      keyword: "云冈石窟", poi: "云冈石窟", fetchedAt: "2026-08-12T00:00:00.000Z",
      candidates: [{ stableId: "poi", index: 0, quality: "4.5", resolution: "1920*1080", imageId: 9, imageUrl: "https://img", imageResolved: true }],
    }),
  });
  assert.equal(result.outcome.written, true);
  const nextCover = ((result.nextProduct.presentation as Record<string, unknown>).cover) as Record<string, unknown>;
  assert.equal(nextCover.imageId, 9);
  assert.equal(nextCover.description, undefined);
});

test("collectCoverSearchKeywords: cover.poi 优先纳入（不短路），再看 spot.name/poiName/字符串，去重", () => {
  // 1) cover.poi 优先纳入，但不短路：itinerary 中其它具名 spot 继续被收进 keyword 列表，
  //    保证首个 POI 搜索无图时还能回退到其它 POI。
  //    makeBaseProduct 默认 cover.poi="云冈石窟"，itinerary day1 spot="晋祠"；
  //    day2 spot="云冈石窟" 被去重剔除；最终 ["云冈石窟", "晋祠"]。
  const product1 = makeBaseProduct();
  assert.deepEqual(collectCoverSearchKeywords(product1), ["云冈石窟", "晋祠"]);

  // 2) cover.poi 空 → 按行程顺序收 spot.name / spot.poiName / 字符串 spot。
  const product2 = makeBaseProduct({
    presentation: {
      recommendation: "推荐语",
      features: "产品特点",
      cover: { source: "ctripLibrary", poi: "", description: "d", minQuality: 3 },
    },
    itinerary: [
      { day: 1, title: "太原出发", spots: [{ name: "晋祠" }, { poiName: "云冈石窟" }] },
      { day: 2, title: "云冈石窟", spots: ["平遥古城"] },
    ],
  });
  assert.deepEqual(collectCoverSearchKeywords(product2), ["晋祠", "云冈石窟", "平遥古城"]);

  // 3) itinerary 为空 → 不退回城市或产品文案。
  const product3 = makeBaseProduct({
    presentation: { recommendation: "推荐语", features: "产品特点" },
    itinerary: [],
  });
  assert.equal(collectCoverSearchKeywords(product3), null);

  // 4) 全空 → null。
  const product4 = {
    sales: { productType: "domesticShort", productForm: "privateTour" },
    basicInfo: { supplierProductName: "", subtitle: "", days: 1 },
    itinerary: [],
  };
  assert.equal(collectCoverSearchKeywords(product4 as Record<string, unknown>), null);

  // 5) 跨字段去重：cover.poi 与 itinerary spot 同名 → 只保留一次（spot dedup）。
  //    day title 在该 day 已有同 seen 的 spot 时不再补，避免"太原"被误搜为 POI。
  const product5 = makeBaseProduct({
    presentation: {
      recommendation: "推荐语",
      features: "产品特点",
      cover: { source: "ctripLibrary", poi: "云冈石窟", description: "d", minQuality: 3 },
    },
    itinerary: [
      { day: 1, title: "太原", spots: [{ name: "云冈石窟" }] },
    ],
  });
  assert.deepEqual(collectCoverSearchKeywords(product5), ["云冈石窟"]);

  // 6) 同一字段内去重（spot 列表中有同名）。
  const product6 = makeBaseProduct({
    presentation: {
      recommendation: "推荐语",
      features: "产品特点",
      cover: { source: "ctripLibrary", poi: "", description: "d", minQuality: 3 },
    },
    itinerary: [
      { day: 1, title: "太原", spots: [{ name: "晋祠" }, { name: "晋祠" }] },
    ],
  });
  assert.deepEqual(collectCoverSearchKeywords(product6), ["晋祠"]);

  // 7) day title 不是景点 POI，不参与封面检索。
  const product7 = makeBaseProduct({
    presentation: {
      recommendation: "推荐语",
      features: "产品特点",
      cover: { source: "ctripLibrary", poi: "", description: "d", minQuality: 3 },
    },
    itinerary: [
      { day: 1, title: "day1 title", spots: [] },
      { day: 2, title: "day2 title", spots: [] },
    ],
  });
  assert.equal(collectCoverSearchKeywords(product7), null);
});
