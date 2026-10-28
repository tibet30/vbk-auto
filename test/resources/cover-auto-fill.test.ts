/** applyAutoCoverFill 相关纯函数：候选完整性、关键词选择、cover 合成。 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  buildCtripLibraryCoverFromCandidate,
  isCoverCandidateComplete,
  isCtripLibraryCoverComplete,
  pickCoverSearchKeyword,
  pickFirstUsableCoverCandidate,
} from "../../src/main/operations/cover-auto-fill.js";
import { makeBaseProduct } from "./cover-auto-fill-fixtures.js";

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

test("pickCoverSearchKeyword 只从景点 POI 取词，不回退城市", () => {
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
  // 3) 没有景点 POI 时不把城市当作景点。
  const product3 = makeBaseProduct({
    presentation: { recommendation: "推荐语", features: "产品特点" },
    itinerary: [],
  });
  assert.equal(pickCoverSearchKeyword(product3), null);
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

test("buildCtripLibraryCoverFromCandidate 缺 existingCover 时不生成 description 或 minQuality", () => {
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
  });
  assert.equal(cover.source, "ctripLibrary");
  assert.equal(cover.imageId, 1);
  assert.equal(cover.imageUrl, "https://img");
  assert.equal(cover.poi, "兵马俑");
  assert.equal(cover.description, undefined);
  assert.equal(cover.minQuality, undefined);
});

test("buildCtripLibraryCoverFromCandidate 不用 keyword 伪造封面描述", () => {
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
  assert.equal(cover.description, undefined);
  assert.equal(cover.minQuality, undefined);
});
