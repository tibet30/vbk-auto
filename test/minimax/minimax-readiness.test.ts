import test from "node:test";
import assert from "node:assert/strict";
import { hasCompleteCtripLibraryCover, isCoverResearchTaskSatisfiedByProduct } from "../../src/main/minimax/minimax.js";

const validCover = {
  source: "ctripLibrary",
  poi: "云冈石窟",
  description: "横版云冈石窟外景或代表性造像",
  minQuality: 3,
};

test("产品草稿缺少 presentation 时封面配置视作无效", () => {
  assert.equal(hasCompleteCtripLibraryCover({ itinerary: [{ day: 1 }] }), false);
});

test("presentation.cover 缺字段时被判定为无效", () => {
  assert.equal(hasCompleteCtripLibraryCover({ presentation: {}, itinerary: [] }), false);
  assert.equal(hasCompleteCtripLibraryCover({ presentation: { cover: { source: "ctripLibrary" } }, itinerary: [] }), false);
});

test("完整有效的 ctripLibrary cover 配置被识别为有效", () => {
  assert.equal(hasCompleteCtripLibraryCover({ presentation: { cover: validCover }, itinerary: [] }), true);
});

test("source 不是 ctripLibrary 时无效", () => {
  assert.equal(hasCompleteCtripLibraryCover({
    presentation: { cover: { ...validCover, source: "vendorLibrary" } },
    itinerary: [],
  }), false);
});

test("minQuality 越界或非整数时无效", () => {
  assert.equal(hasCompleteCtripLibraryCover({
    presentation: { cover: { ...validCover, minQuality: 6 } },
    itinerary: [],
  }), false);
  assert.equal(hasCompleteCtripLibraryCover({
    presentation: { cover: { ...validCover, minQuality: -1 } },
    itinerary: [],
  }), false);
  assert.equal(hasCompleteCtripLibraryCover({
    presentation: { cover: { ...validCover, minQuality: 3.5 } },
    itinerary: [],
  }), false);
});

test("空 poi/描述或携带图片字段时无效", () => {
  assert.equal(hasCompleteCtripLibraryCover({
    presentation: { cover: { ...validCover, poi: "" } },
    itinerary: [],
  }), false);
  assert.equal(hasCompleteCtripLibraryCover({
    presentation: { cover: { ...validCover, description: "  " } },
    itinerary: [],
  }), false);
  assert.equal(hasCompleteCtripLibraryCover({
    presentation: { cover: { ...validCover, imageUrl: "https://x" } },
    itinerary: [],
  }), false);
});

test("type 非 image 的 research task 始终视为未被覆盖", () => {
  const product = { presentation: { cover: validCover }, itinerary: [] };
  for (const type of ["vbk", "web", "cost"] as const) {
    assert.equal(isCoverResearchTaskSatisfiedByProduct({ type, label: "核查" }, product), false);
  }
});

test("type=image 且产品已有完整 cover 配置时不再阻塞", () => {
  const product = { presentation: { cover: validCover }, itinerary: [] };
  assert.equal(isCoverResearchTaskSatisfiedByProduct({
    type: "image", label: "获取产品封面图", detail: "POI 云冈石窟；描述：横版；最低质量 3。",
  }, product), true);
});

test("type=image 但产品缺少有效 cover 配置时仍阻塞", () => {
  assert.equal(isCoverResearchTaskSatisfiedByProduct({
    type: "image", label: "获取产品封面图",
  }, { itinerary: [] }), false);
  assert.equal(isCoverResearchTaskSatisfiedByProduct({
    type: "image", label: "获取产品封面图",
  }, { presentation: { cover: { source: "ctripLibrary", poi: "", description: "横版", minQuality: 3 } }, itinerary: [] }), false);
  assert.equal(isCoverResearchTaskSatisfiedByProduct({
    type: "image", label: "获取产品封面图",
  }, { presentation: {}, itinerary: [] }), false);
});