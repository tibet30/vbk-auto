import test from "node:test";
import assert from "node:assert/strict";
import { normalisePresentation } from "../src/main/product-normalize.js";

test("AI 给出 3 项 recommendations 时原样保留", () => {
  const result = normalisePresentation({
    recommendationCategory: "优选行程",
    recommendation: "主推荐语",
    recommendations: [
      { category: "优选行程", text: "推荐 1" },
      { category: "精选酒店", text: "推荐 2" },
      { category: "缤纷景点", text: "推荐 3" },
    ],
    features: "特点",
  });
  assert.equal(result?.recommendations.length, 3);
  assert.equal(result?.recommendations[0].category, "优选行程");
});

test("AI 未给出 recommendations 时从旧字段兜底到 3 项", () => {
  const result = normalisePresentation({
    recommendationCategory: "精选酒店",
    recommendation: "主推荐语",
    features: "特点",
  });
  assert.equal(result?.recommendations.length, 3);
  // 第 1 项应是旧字段的复制
  assert.equal(result?.recommendations[0].category, "精选酒店");
  assert.equal(result?.recommendations[0].text, "主推荐语");
});

test("非白名单分类被丢弃并报错", () => {
  assert.throws(() => normalisePresentation({
    recommendationCategory: "优选行程",
    recommendation: "主推荐语",
    recommendations: [
      { category: "超值套餐", text: "非法" },
      { category: "精选酒店", text: "合法" },
      { category: "缤纷景点", text: "合法" },
    ],
    features: "特点",
  }), /推荐理由分类.*不在白名单/);
});

test("重复 category 被去重并补足", () => {
  const result = normalisePresentation({
    recommendationCategory: "优选行程",
    recommendation: "主推荐语",
    recommendations: [
      { category: "优选行程", text: "A" },
      { category: "优选行程", text: "B" }, // 重复
      { category: "缤纷景点", text: "C" },
    ],
    features: "特点",
  });
  const cats = result?.recommendations.map((r) => r.category);
  assert.equal(new Set(cats).size, 3); // 3 个不同分类
});
