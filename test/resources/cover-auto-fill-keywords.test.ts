/** applyAutoCoverFill 关键词回退、搜索失败继续、无合格候选停下与关键词去重。 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  applyAutoCoverFill,
  collectCoverSearchKeywords,
} from "../../src/main/operations/cover-auto-fill.js";
import { makeBaseProduct } from "./cover-auto-fill-fixtures.js";

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

test("无合格候选时不写占位图并返回阻塞原因", async () => {
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
  assert.match(result.outcome.reason, /2 个景点（晋祠、云冈石窟）/);
  assert.match(result.outcome.reason, /请重试或人工上传\/选择图库图片/);
  assert.equal((result.nextProduct.presentation as Record<string, unknown>).coverFallback, undefined);
  assert.equal((product.presentation as Record<string, unknown>).coverFallback, undefined);
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
