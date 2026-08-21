import test from "node:test";
import assert from "node:assert/strict";
import {
  applyAutoCoverFill,
  buildCtripLibraryCoverFromCandidate,
  collectCoverSearchKeywords,
  isCoverCandidateComplete,
  isCtripLibraryCoverComplete,
  pickCoverSearchKeyword,
  pickFirstUsableCoverCandidate,
} from "../../src/main/operations/cover-auto-fill.js";

function makeBaseProduct(extra: Record<string, unknown> = {}) {
  return {
    sales: { productType: "domesticShort", productForm: "privateTour", splitGroup: false },
    basicInfo: {
      supplierProductName: "太原2天1晚私家团",
      supplierProductCode: "TY-AUTO-1",
      subtitle: "太原经典私家团",
      days: 2,
      nights: 1,
      meetingCity: "太原",
      destinationCity: "太原",
      province: "山西",
      operationNotes: "无",
    },
    presentation: {
      recommendation: "推荐语",
      features: "产品特点",
      cover: {
        source: "ctripLibrary",
        poi: "云冈石窟",
        description: "云冈石窟 1",
        minQuality: 3,
      },
    },
    operations: { transport: "charter", pickupCity: "太原" },
    itinerary: [
      { day: 1, title: "太原出发", spots: [{ name: "晋祠" }] },
      { day: 2, title: "云冈石窟", spots: [{ name: "云冈石窟" }] },
    ],
    ...extra,
  };
}

test("isCoverCandidateComplete 拒绝缺 imageId / imageUrl / imageResolved=false / 未确认的候选", () => {
  assert.equal(isCoverCandidateComplete({ imageId: 1, imageUrl: "u", imageResolved: false }), false);
  // imageResolved 缺省视为未确认，与 false 等价：拒绝。
  assert.equal(isCoverCandidateComplete({ imageId: 1, imageUrl: "u" }), false);
  assert.equal(isCoverCandidateComplete({ imageId: 1, imageUrl: "" }), false);
  assert.equal(isCoverCandidateComplete({ imageId: 0, imageUrl: "u" }), false);
  assert.equal(isCoverCandidateComplete({ imageId: 1 }), false);
  assert.equal(isCoverCandidateComplete({}), false);
  assert.equal(isCoverCandidateComplete(null), false);
  const ok = isCoverCandidateComplete({
    imageId: 1234,
    imageUrl: "https://x",
    imageResolved: true,
    previewUrl: "https://p",
    poiName: "云冈石窟",
    poiId: 99,
    score: 4.5,
    resolution: "1920*1080",
  });
  assert.equal(ok, true);
});

test("isCtripLibraryCoverComplete 同时要求 imageId > 0 + imageUrl 非空（manualUpload 视为已完整）", () => {
  assert.equal(isCtripLibraryCoverComplete({ source: "ctripLibrary", poi: "a", description: "b", minQuality: 3 }), false);
  assert.equal(
    isCtripLibraryCoverComplete({
      source: "ctripLibrary",
      poi: "a",
      description: "b",
      minQuality: 3,
      imageId: 1,
      imageUrl: "u",
    }),
    true,
  );
  assert.equal(isCtripLibraryCoverComplete({ source: "manualUpload", fileId: "x" }), true);
  assert.equal(isCtripLibraryCoverComplete(null), false);
});

test("pickFirstUsableCoverCandidate 按顺序挑第一条完整候选", () => {
  const list = [
    { stableId: "a", index: 0, quality: "", resolution: "", imageId: undefined as unknown as number, imageUrl: undefined as unknown as string },
    { stableId: "b", index: 1, quality: "", resolution: "", imageId: 0, imageUrl: "" },
    { stableId: "c", index: 2, quality: "", resolution: "", imageId: 100, imageUrl: "https://c" },
    { stableId: "d", index: 3, quality: "3.2", resolution: "2000*1200", imageId: 200, imageUrl: "https://d", imageResolved: true },
  ];
  // imageResolved === undefined 视为未确认：c 缺标记被跳过，挑 d。
  const picked = pickFirstUsableCoverCandidate(list);
  assert.equal(picked?.stableId, "d");
  // 整组都缺 imageResolved=true：全表跳过。
  const listAllUnresolved = [
    { stableId: "a", index: 0, quality: "3.2", resolution: "2000*1200", imageId: 100, imageUrl: "https://a" },
    { stableId: "b", index: 1, quality: "3.1", resolution: "2000*1200", imageId: 200, imageUrl: "https://b" },
  ];
  assert.equal(pickFirstUsableCoverCandidate(listAllUnresolved), null);
});

test("pickCoverSearchKeyword 优先 cover.poi，再 itinerary spot，再 basicInfo", () => {
  // 1) cover.poi 优先。
  const product1 = makeBaseProduct();
  assert.equal(pickCoverSearchKeyword(product1), "云冈石窟");
  // 2) 没有 cover.poi 时按行程顺序第一个 spot.name。
  const product2 = makeBaseProduct({
    presentation: {
      recommendation: "推荐语",
      features: "产品特点",
      cover: { source: "ctripLibrary", poi: "", description: "d", minQuality: 3 },
    },
  });
  assert.equal(pickCoverSearchKeyword(product2), "晋祠");
  // 3) 没有 cover.poi 且 itinerary 为空，回退 basicInfo.destinationCity / meetingCity。
  const product3 = makeBaseProduct({
    presentation: { recommendation: "推荐语", features: "产品特点" },
    itinerary: [],
  });
  assert.equal(pickCoverSearchKeyword(product3), "太原");
  // 4) 都没有 → null。
  const product4 = {
    sales: { productType: "domesticShort", productForm: "privateTour" },
    basicInfo: { supplierProductName: "", subtitle: "", days: 1 },
    itinerary: [],
  };
  assert.equal(pickCoverSearchKeyword(product4 as Record<string, unknown>), null);
});

test("buildCtripLibraryCoverFromCandidate 只合成完整 cover，缺 description 时回退到 keyword", () => {
  const cover = buildCtripLibraryCoverFromCandidate({
    existingCover: { source: "ctripLibrary", poi: "云冈石窟", description: "云冈石窟横版", minQuality: 4 },
    candidate: {
      stableId: "x",
      index: 0,
      quality: "4.5",
      resolution: "1920*1080",
      imageId: 12345,
      imageUrl: "https://img",
      previewUrl: "https://preview",
      thumbnailUrl: "https://thumb",
      poiName: "云冈石窟",
      poiId: 99,
      score: 4.5,
      imageResolved: true,
    },
    keyword: "云冈石窟",
    selectedAt: "2026-08-12T00:00:00.000Z",
  });
  assert.equal(cover.source, "ctripLibrary");
  assert.equal(cover.imageId, 12345);
  assert.equal(cover.imageUrl, "https://img");
  assert.equal(cover.poi, "云冈石窟");
  assert.equal(cover.description, "云冈石窟横版");
  assert.equal(cover.minQuality, 4);
  assert.equal(cover.score, 4.5);
  assert.equal(cover.poiId, 99);
  assert.equal(cover.poiName, "云冈石窟");
  assert.equal(cover.resolution, "1920*1080");
  assert.equal(cover.thumbnailUrl, "https://thumb");
  assert.equal(cover.previewUrl, "https://preview");
  assert.equal(cover.selectedAt, "2026-08-12T00:00:00.000Z");
});

test("buildCtripLibraryCoverFromCandidate 缺 existingCover 时使用 fallbackDescription", () => {
  const cover = buildCtripLibraryCoverFromCandidate({
    existingCover: null,
    candidate: {
      stableId: "x",
      index: 0,
      quality: "4.5",
      resolution: "1920*1080",
      imageId: 1,
      imageUrl: "https://img",
      imageResolved: true,
      poiName: "兵马俑",
    },
    keyword: "兵马俑",
    selectedAt: "2026-08-12T00:00:00.000Z",
    fallbackDescription: "千年古都私家定制2日游",
  });
  assert.equal(cover.source, "ctripLibrary");
  assert.equal(cover.imageId, 1);
  assert.equal(cover.imageUrl, "https://img");
  assert.equal(cover.poi, "兵马俑");
  assert.equal(cover.description, "千年古都私家定制2日游");
  assert.equal(cover.minQuality, 3);
});

test("buildCtripLibraryCoverFromCandidate 缺 existingCover 且无 fallbackDescription 时用 keyword 兜底", () => {
  const cover = buildCtripLibraryCoverFromCandidate({
    existingCover: null,
    candidate: {
      stableId: "x",
      index: 0,
      quality: "4.5",
      resolution: "1920*1080",
      imageId: 1,
      imageUrl: "https://img",
      imageResolved: true,
      poiName: "华山",
    },
    keyword: "华山",
    selectedAt: "2026-08-12T00:00:00.000Z",
  });
  assert.equal(cover.poi, "华山");
  assert.equal(cover.description, "华山 封面图");
  assert.equal(cover.minQuality, 3);
});

test("applyAutoCoverFill: cover 已完整时直接跳过，不发请求", async () => {
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
  assert.match(result.outcome.reason, /已完整/);
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

test("applyAutoCoverFill: search 抛错时返回 { written: false } 不阻塞 draft", async () => {
  const product = makeBaseProduct();
  const page = {
    evaluate: async () => {
      throw new Error("simulated vbk offline");
    },
  };
  const result = await applyAutoCoverFill({ page: page as never, product });
  assert.equal(result.outcome.written, false);
  assert.match(result.outcome.reason, /失败/);
  // 失败时 nextProduct 必须保持引用相等（不污染 product）。
  assert.equal(result.nextProduct, product);
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

test("applyAutoCoverFill: cover 缺 description 时跳过，绝不写半成品", async () => {
  const product = makeBaseProduct({
    presentation: {
      recommendation: "推荐语",
      features: "产品特点",
      cover: { source: "ctripLibrary", poi: "云冈石窟", description: "", minQuality: 3 },
    },
  });
  const page = {
    evaluate: async () => ({ status: 200, durationMs: 1, ctx: { hasCid: true, cookieNameCount: 1, hasGuidCookie: true, hasVbkLoginCidCookie: false }, payload: {} }),
  };
  const result = await applyAutoCoverFill({ page: page as never, product });
  assert.equal(result.outcome.written, false);
  assert.match(result.outcome.reason, /description/);
  assert.equal(result.nextProduct, product);
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

  // 3) itinerary 为空 → 退回 basicInfo.destinationCity / meetingCity / supplierProductName / subtitle。
  const product3 = makeBaseProduct({
    presentation: { recommendation: "推荐语", features: "产品特点" },
    itinerary: [],
  });
  assert.deepEqual(collectCoverSearchKeywords(product3), ["太原"]);

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

  // 7) day title 仅在 spot 都没有时才看，且不应"覆盖" spot 已有的关键字。
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
  assert.deepEqual(collectCoverSearchKeywords(product7), ["day1 title", "day2 title"]);
});

test("applyAutoCoverFill: 第一个 POI 候选空/不完整，第二个 POI 成功时用第二个 keyword 写回", async () => {
  const product = makeBaseProduct({
    presentation: {
      recommendation: "推荐语",
      features: "产品特点",
      cover: { source: "ctripLibrary", poi: "", description: "d", minQuality: 3 },
    },
    itinerary: [
      { day: 1, title: "太原", spots: [{ name: "晋祠" }] },
      { day: 2, title: "云冈石窟", spots: [{ name: "云冈石窟" }] },
    ],
  });
  const tried: string[] = [];
  const result = await applyAutoCoverFill({
    page: {} as never,
    product,
    now: () => "2026-08-12T00:00:00.000Z",
    injectSearch: async (_page, keyword) => {
      tried.push(keyword);
      if (keyword === "晋祠") {
        // 第一次：先返回空候选；下次返回 candidates 但 imageResolved 缺失。
        return {
          keyword,
          poi: "",
          fetchedAt: "2026-08-12T00:00:00.000Z",
          candidates: [],
        };
      }
      return {
        keyword,
        poi: "",
        fetchedAt: "2026-08-12T00:00:00.000Z",
        candidates: [
          {
            stableId: "y",
            index: 0,
            quality: "4.5",
            resolution: "1920*1080",
            imageId: 222,
            imageUrl: "https://img2",
            imageResolved: true,
            poiName: "云冈石窟",
          },
        ],
      };
    },
  });
  assert.deepEqual(tried, ["晋祠", "云冈石窟"]);
  assert.equal(result.outcome.written, true);
  assert.equal(result.outcome.keyword, "云冈石窟");
  assert.equal(result.outcome.imageId, 222);
  const nextCover = ((result.nextProduct.presentation as Record<string, unknown>).cover) as Record<string, unknown>;
  assert.equal(nextCover.imageId, 222);
  assert.equal(nextCover.imageUrl, "https://img2");
  assert.equal(nextCover.poi, "云冈石窟");
});

test("collectCoverSearchKeywords + applyAutoCoverFill: cover.poi 搜索无候选，回退到 itinerary spot 写回", async () => {
  // cover.poi = 云冈石窟；itinerary 提供晋祠。
  // 期望：keywords = ["云冈石窟", "晋祠"]，搜云冈石窟（空 candidates）后，
  // 继续搜晋祠并写回，outcome.keyword = "晋祠"。
  const product = makeBaseProduct({
    presentation: {
      recommendation: "推荐语",
      features: "产品特点",
      cover: { source: "ctripLibrary", poi: "云冈石窟", description: "d", minQuality: 3 },
    },
    itinerary: [
      { day: 1, title: "太原", spots: [{ name: "晋祠" }] },
    ],
  });
  // 收集关键词：cover.poi 必须在前，晋祠作为 itinerary 后续关键词纳入。
  assert.deepEqual(collectCoverSearchKeywords(product), ["云冈石窟", "晋祠"]);
  const tried: string[] = [];
  const result = await applyAutoCoverFill({
    page: {} as never,
    product,
    now: () => "2026-08-12T00:00:00.000Z",
    injectSearch: async (_page, keyword) => {
      tried.push(keyword);
      if (keyword === "云冈石窟") {
        // 云冈石窟返回空 candidates：模拟「代表景点搜不到图」。
        return {
          keyword,
          poi: "",
          fetchedAt: "2026-08-12T00:00:00.000Z",
          candidates: [],
        };
      }
      return {
        keyword,
        poi: "",
        fetchedAt: "2026-08-12T00:00:00.000Z",
        candidates: [
          {
            stableId: "j",
            index: 0,
            quality: "4.5",
            resolution: "1920*1080",
            imageId: 555,
            imageUrl: "https://img5",
            imageResolved: true,
            poiName: "晋祠",
          },
        ],
      };
    },
  });
  // 实际搜索顺序：cover.poi → 第一个 itinerary spot。
  assert.deepEqual(tried, ["云冈石窟", "晋祠"]);
  assert.equal(result.outcome.written, true);
  assert.equal(result.outcome.keyword, "晋祠");
  assert.equal(result.outcome.imageId, 555);
  const nextCover = ((result.nextProduct.presentation as Record<string, unknown>).cover) as Record<string, unknown>;
  assert.equal(nextCover.imageId, 555);
  assert.equal(nextCover.imageUrl, "https://img5");
  // cover.poi 必须代表选中 image 对应的 POI，不能继承前一次失败的 existing.poi=云冈石窟。
  // 优先级 candidate.poiName("晋祠") > keyword("晋祠") > existing.poi(被覆盖)。
  assert.equal(nextCover.poi, "晋祠");
  assert.notEqual(nextCover.poi, "云冈石窟");
  // description/minQuality 仍然沿用 existing cover 的值。
  assert.equal(nextCover.description, "d");
  assert.equal(nextCover.minQuality, 3);
});

test("applyAutoCoverFill: 回退搜索时 candidate.poiName(如晋祠博物馆)优先于 keyword / existing.poi", async () => {
  // 真实 smoke：cover.poi=云冈石窟 搜不到，回退 keyword=晋祠，candidate.poiName=晋祠博物馆。
  // 期望 nextCover.poi="晋祠博物馆"，确保 cover.poi 与选中 image 匹配。
  const product = makeBaseProduct({
    presentation: {
      recommendation: "推荐语",
      features: "产品特点",
      cover: { source: "ctripLibrary", poi: "云冈石窟", description: "横版", minQuality: 4 },
    },
    itinerary: [
      { day: 1, title: "太原", spots: [{ name: "晋祠" }] },
    ],
  });
  const tried: string[] = [];
  const result = await applyAutoCoverFill({
    page: {} as never,
    product,
    now: () => "2026-08-12T00:00:00.000Z",
    injectSearch: async (_page, keyword) => {
      tried.push(keyword);
      if (keyword === "云冈石窟") {
        return {
          keyword,
          poi: "",
          fetchedAt: "2026-08-12T00:00:00.000Z",
          candidates: [],
        };
      }
      return {
        keyword,
        poi: "",
        fetchedAt: "2026-08-12T00:00:00.000Z",
        candidates: [
          {
            stableId: "f",
            index: 0,
            quality: "4.5",
            resolution: "1920*1080",
            imageId: 666,
            imageUrl: "https://img6",
            imageResolved: true,
            poiName: "晋祠博物馆",
            poiId: 88,
          },
        ],
      };
    },
  });
  assert.deepEqual(tried, ["云冈石窟", "晋祠"]);
  assert.equal(result.outcome.written, true);
  assert.equal(result.outcome.keyword, "晋祠");
  assert.equal(result.outcome.imageId, 666);
  const nextCover = ((result.nextProduct.presentation as Record<string, unknown>).cover) as Record<string, unknown>;
  assert.equal(nextCover.imageId, 666);
  assert.equal(nextCover.imageUrl, "https://img6");
  // 关键断言：cover.poi 反映「选中的 POI」，即 candidate.poiName，不能是 existing.poi="云冈石窟"。
  assert.equal(nextCover.poi, "晋祠博物馆");
  assert.notEqual(nextCover.poi, "云冈石窟");
  // description / minQuality 仍沿用 existing cover。
  assert.equal(nextCover.description, "横版");
  assert.equal(nextCover.minQuality, 4);
  // poiId 等 candidate 派生字段正常透传。
  assert.equal(nextCover.poiName, "晋祠博物馆");
  assert.equal(nextCover.poiId, 88);
});

test("applyAutoCoverFill: 第一个 keyword search 抛错，第二个 keyword 成功", async () => {
  const product = makeBaseProduct({
    presentation: {
      recommendation: "推荐语",
      features: "产品特点",
      cover: { source: "ctripLibrary", poi: "", description: "d", minQuality: 3 },
    },
    itinerary: [
      { day: 1, title: "太原", spots: [{ name: "晋祠" }] },
      { day: 2, title: "云冈石窟", spots: [{ name: "云冈石窟" }] },
    ],
  });
  const tried: string[] = [];
  const result = await applyAutoCoverFill({
    page: {} as never,
    product,
    now: () => "2026-08-12T00:00:00.000Z",
    injectSearch: async (_page, keyword) => {
      tried.push(keyword);
      if (keyword === "晋祠") {
        throw new Error("simulated offline");
      }
      return {
        keyword,
        poi: "",
        fetchedAt: "2026-08-12T00:00:00.000Z",
        candidates: [
          {
            stableId: "z",
            index: 0,
            quality: "4.5",
            resolution: "1920*1080",
            imageId: 333,
            imageUrl: "https://img3",
            imageResolved: true,
            poiName: "云冈石窟",
          },
        ],
      };
    },
  });
  assert.deepEqual(tried, ["晋祠", "云冈石窟"]);
  assert.equal(result.outcome.written, true);
  assert.equal(result.outcome.keyword, "云冈石窟");
  assert.equal(result.outcome.imageId, 333);
});

test("applyAutoCoverFill: 所有关键词都失败时返回原 product 引用且 written=false", async () => {
  const product = makeBaseProduct({
    presentation: {
      recommendation: "推荐语",
      features: "产品特点",
      cover: { source: "ctripLibrary", poi: "", description: "d", minQuality: 3 },
    },
    itinerary: [
      { day: 1, title: "太原", spots: [{ name: "晋祠" }] },
      { day: 2, title: "云冈石窟", spots: [{ name: "云冈石窟" }] },
    ],
  });
  const tried: string[] = [];
  const result = await applyAutoCoverFill({
    page: {} as never,
    product,
    injectSearch: async (_page, keyword) => {
      tried.push(keyword);
      // 候选都缺 imageResolved：所有候选都视为不完整。
      return {
        keyword,
        poi: "",
        fetchedAt: "2026-08-12T00:00:00.000Z",
        candidates: [
          {
            stableId: "x",
            index: 0,
            quality: "4.5",
            resolution: "1920*1080",
            imageId: 9,
            imageUrl: "https://x",
            // imageResolved=undefined 视为未确认
          },
        ],
      };
    },
  });
  assert.deepEqual(tried, ["晋祠", "云冈石窟"]);
  assert.equal(result.outcome.written, false);
  // reason 应当列出尝试过的关键词数（不能让排查时灰屏）。
  assert.match(result.outcome.reason, /2/);
  assert.match(result.outcome.reason, /晋祠/);
  assert.match(result.outcome.reason, /云冈石窟/);
  // 失败时 nextProduct 保持引用相等（不污染 product）。
  assert.equal(result.nextProduct, product);
});

test("applyAutoCoverFill: 关键词去重——重复出现的 keyword 只搜一次", async () => {
  const product = makeBaseProduct({
    presentation: {
      recommendation: "推荐语",
      features: "产品特点",
      cover: { source: "ctripLibrary", poi: "云冈石窟", description: "d", minQuality: 3 },
    },
    itinerary: [
      { day: 1, title: "太原", spots: [{ name: "云冈石窟" }] },
      { day: 2, title: "云冈石窟", spots: [{ name: "云冈石窟" }] },
    ],
  });
  let calls = 0;
  const result = await applyAutoCoverFill({
    page: {} as never,
    product,
    now: () => "2026-08-12T00:00:00.000Z",
    injectSearch: async (_page, _keyword) => {
      calls += 1;
      return {
        keyword: "云冈石窟",
        poi: "",
        fetchedAt: "2026-08-12T00:00:00.000Z",
        candidates: [
          {
            stableId: "d",
            index: 0,
            quality: "4.5",
            resolution: "1920*1080",
            imageId: 444,
            imageUrl: "https://img4",
            imageResolved: true,
            poiName: "云冈石窟",
          },
        ],
      };
    },
  });
  assert.equal(calls, 1);
  assert.equal(result.outcome.written, true);
  assert.equal(result.outcome.keyword, "云冈石窟");
  assert.equal(result.outcome.imageId, 444);
});
