/** applyAutoCoverFill 候选池轮询、10 张上限与剩余图写入 spot.images。 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  applyAutoCoverFill,
} from "../../src/main/operations/cover-auto-fill.js";
import { makeBaseProduct } from "./cover-auto-fill-fixtures.js";

test("applyAutoCoverFill: 每个景点尽量多抓图，round-robin 轮询，最多 10 张", async () => {
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

  // 每个 POI 返回 4 张图（同 POI 多张、imageResolved=true），验证同景点可多图。
  const idsByKeyword: Record<string, number[]> = {
    "晋祠": [101, 102, 103, 104],
    "云冈石窟": [201, 202, 203, 204],
    "平遥古城": [301, 302, 303, 304],
  };
  const result = await applyAutoCoverFill({
    page: {} as never,
    product,
    now: () => "2026-08-12T00:00:00.000Z",
    injectSearch: async (_page, keyword) => ({
      keyword,
      poi: "",
      fetchedAt: "2026-08-12T00:00:00.000Z",
      candidates: (idsByKeyword[keyword] ?? []).map((imageId, index) => ({
        stableId: `${keyword}-${imageId}`,
        index,
        quality: "4.5",
        resolution: "1920*1080",
        imageId,
        imageUrl: `https://img/${imageId}`,
        imageResolved: true,
        poiName: keyword,
      })),
    }),
  });

  assert.equal(result.outcome.written, true);
  // round-robin：每个景点先各取 1 张，再从头轮流补足，直到 10 张。
  assert.deepEqual(result.outcome.imageIds, [101, 201, 301, 102, 202, 302, 103, 203, 303, 104]);
  const nextCover = ((result.nextProduct.presentation as Record<string, unknown>).cover) as Record<string, unknown>;
  assert.equal(nextCover.imageId, 101);
  assert.equal((nextCover.alternates as Array<Record<string, unknown>>).length, 9);
});

test("applyAutoCoverFill: 单个景点多张图时取满上限 10 张", async () => {
  const product = makeBaseProduct({
    presentation: {
      recommendation: "推荐语",
      features: "产品特点",
      cover: { source: "ctripLibrary", poi: "", description: "d", minQuality: 3 },
    },
    itinerary: [{ day: 1, title: "太原", spots: [{ name: "晋祠" }] }],
  });
  const result = await applyAutoCoverFill({
    page: {} as never,
    product,
    now: () => "2026-08-12T00:00:00.000Z",
    injectSearch: async (_page, keyword) => ({
      keyword,
      poi: "",
      fetchedAt: "2026-08-12T00:00:00.000Z",
      candidates: Array.from({ length: 12 }, (_, index) => ({
        stableId: `j-${index}`,
        index,
        quality: "4.5",
        resolution: "1920*1080",
        imageId: 1000 + index,
        imageUrl: `https://img/${1000 + index}`,
        imageResolved: true,
        poiName: keyword,
      })),
    }),
  });
  assert.equal(result.outcome.written, true);
  assert.equal(result.outcome.imageIds?.length, 10);
  const nextCover = ((result.nextProduct.presentation as Record<string, unknown>).cover) as Record<string, unknown>;
  assert.equal((nextCover.alternates as Array<Record<string, unknown>>).length, 9);
});

test("applyAutoCoverFill: 封面取满后剩余图按 POI 归属写入 itinerary[].spots[].images", async () => {
  // 3 个 POI 各 5 张候选，共 15 张。round-robin 取 10 张进封面：
  //   - POI1(晋祠) 4 张进封面 (101,102,103,104)，剩 1 张 (105)；
  //   - POI2(云冈石窟) 3 张进封面 (201,202,203)，剩 2 张 (204,205)；
  //   - POI3(平遥古城) 3 张进封面 (301,302,303)，剩 2 张 (304,305)。
  // 阶段三把 5 张剩余按 POI 归属写进对应 spot.images，cover 已用 imageId 不重复落。
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
  const idsByKeyword: Record<string, number[]> = {
    "晋祠": [101, 102, 103, 104, 105],
    "云冈石窟": [201, 202, 203, 204, 205],
    "平遥古城": [301, 302, 303, 304, 305],
  };
  const result = await applyAutoCoverFill({
    page: {} as never,
    product,
    now: () => "2026-08-12T00:00:00.000Z",
    injectSearch: async (_page, keyword) => ({
      keyword,
      poi: "",
      fetchedAt: "2026-08-12T00:00:00.000Z",
      candidates: (idsByKeyword[keyword] ?? []).map((imageId, index) => ({
        stableId: `${keyword}-${imageId}`,
        index,
        quality: "4.5",
        resolution: "1920*1080",
        imageId,
        imageUrl: `https://img/${imageId}`,
        imageResolved: true,
        poiName: keyword,
      })),
    }),
  });
  assert.equal(result.outcome.written, true);
  assert.deepEqual(result.outcome.imageIds, [101, 201, 301, 102, 202, 302, 103, 203, 303, 104]);
  assert.equal(result.outcome.spotImagesWritten, 5);

  const nextItinerary = result.nextProduct.itinerary as Array<Record<string, unknown>>;
  const day1Images = ((nextItinerary[0].spots as Array<Record<string, unknown>>)[0].images as Array<{ imageId: number; poi: string }>);
  assert.deepEqual(day1Images.map((i) => [i.imageId, i.poi]), [[105, "晋祠"]]);
  const day2Images = ((nextItinerary[1].spots as Array<Record<string, unknown>>)[0].images as Array<{ imageId: number; poi: string }>);
  assert.deepEqual(day2Images.map((i) => [i.imageId, i.poi]), [[204, "云冈石窟"], [205, "云冈石窟"]]);
  const day3Images = ((nextItinerary[2].spots as Array<Record<string, unknown>>)[0].images as Array<{ imageId: number; poi: string }>);
  assert.deepEqual(day3Images.map((i) => [i.imageId, i.poi]), [[304, "平遥古城"], [305, "平遥古城"]]);

  // 关键：cover 已用的 imageId (101~104) 不会再次出现在任何 spot.images 中。
  const allSpotImageIds = [day1Images, day2Images, day3Images].flatMap((list) => list.map((i) => i.imageId));
  for (const coverId of result.outcome.imageIds ?? []) {
    assert.equal(allSpotImageIds.includes(coverId), false, `cover imageId ${coverId} 不应重复落到 spot.images`);
  }
});

test("applyAutoCoverFill: 单 POI 候选池很大时，spot.images 最多保留 10 张", async () => {
  // 单 POI 20 张候选；封面取满 10 张 (1000~1009)；剩 10 张按 SPOT_IMAGE_TARGET_COUNT=10 全部落进 spot.images。
  const product = makeBaseProduct({
    presentation: {
      recommendation: "推荐语",
      features: "产品特点",
      cover: { source: "ctripLibrary", poi: "晋祠", description: "d", minQuality: 3 },
    },
    itinerary: [{ day: 1, title: "太原", spots: [{ name: "晋祠" }] }],
  });
  const result = await applyAutoCoverFill({
    page: {} as never,
    product,
    now: () => "2026-08-12T00:00:00.000Z",
    injectSearch: async () => ({
      keyword: "晋祠",
      poi: "晋祠",
      fetchedAt: "2026-08-12T00:00:00.000Z",
      candidates: Array.from({ length: 20 }, (_, index) => ({
        stableId: `j-${index}`,
        index,
        quality: "4.5",
        resolution: "1920*1080",
        imageId: 1000 + index,
        imageUrl: `https://img/${1000 + index}`,
        imageResolved: true,
        poiName: "晋祠",
      })),
    }),
  });
  assert.equal(result.outcome.written, true);
  assert.equal(result.outcome.imageIds?.length, 10);
  assert.equal(result.outcome.spotImagesWritten, 10);
  const day1Spot = ((result.nextProduct.itinerary as Array<Record<string, unknown>>)[0].spots as Array<Record<string, unknown>>)[0];
  const images = day1Spot.images as Array<{ imageId: number }>;
  assert.equal(images.length, 10);
  // 封面占 1000~1009，剩 1010~1019 全部落进 spot.images。
  assert.deepEqual(images.map((i) => i.imageId), [1010, 1011, 1012, 1013, 1014, 1015, 1016, 1017, 1018, 1019]);
});

test("applyAutoCoverFill: 候选 POI 不在行程中时，不写入 spot.images", async () => {
  // 行程只有「晋祠」一个 spot；但 search 返回的 candidate.poiName="无关景点"。
  // 匹配规则要求 candidate.poiId === spot.poiId 或 candidate.poiName 与 spot.name/poiName 互含，
  // 都不满足时该 candidate 不进 spot.images（但仍可能进 cover，因为 matchesItineraryCoverPoi
  // 允许 itinerary 没有任何 POI ID 时接纳 nameless candidate）。
  // 简化：让 cover.poi = "无关景点"，search 只返回该 POI 的图，POI 不在行程中；
  // 期望 cover 写入成功（matchesItineraryCoverPoi 在 knownPoiIds 空时允许 nameless），
  // 但因行程只有「晋祠」，candidate 落不进 spot.images。
  const product = makeBaseProduct({
    presentation: {
      recommendation: "推荐语",
      features: "产品特点",
      cover: { source: "ctripLibrary", poi: "无关景点", description: "d", minQuality: 3 },
    },
    itinerary: [{ day: 1, title: "太原", spots: [{ name: "晋祠" }] }],
  });
  const result = await applyAutoCoverFill({
    page: {} as never,
    product,
    now: () => "2026-08-12T00:00:00.000Z",
    injectSearch: async () => ({
      keyword: "无关景点",
      poi: "",
      fetchedAt: "2026-08-12T00:00:00.000Z",
      candidates: [
        {
          stableId: "x",
          index: 0,
          quality: "4.5",
          resolution: "1920*1080",
          imageId: 999,
          imageUrl: "https://img/999",
          imageResolved: true,
          poiName: "无关景点",
        },
        {
          stableId: "y",
          index: 1,
          quality: "4.5",
          resolution: "1920*1080",
          imageId: 998,
          imageUrl: "https://img/998",
          imageResolved: true,
          poiName: "无关景点",
        },
      ],
    }),
  });
  assert.equal(result.outcome.written, true);
  // 封面占用 999、998；行程里没有「无关景点」spot → spotImagesWritten 应为 0。
  assert.equal(result.outcome.spotImagesWritten, 0);
  const nextItinerary = result.nextProduct.itinerary as Array<Record<string, unknown>>;
  // 行程结构保持原样（晋祠 spot 无 images）。
  const day1Spot = (nextItinerary[0].spots as Array<Record<string, unknown>>)[0];
  assert.equal(day1Spot.images, undefined);
});
