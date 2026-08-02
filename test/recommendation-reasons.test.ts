import test from "node:test";
import assert from "node:assert/strict";
import { RECOMMENDATION_CATEGORIES } from "../src/main/automation/schema.js";

// 占位：以下函数从 ctrip.ts 导出纯函数 buildRecommendationReasonsPlan 用于测试。
// 该函数接受 recommendations: Array<{category, text}>，返回每步 plan（便于断言）。
import { buildRecommendationReasonsPlan } from "../src/main/automation/ctrip.js";

test("3 项分类去重后顺序保留", () => {
  const plan = buildRecommendationReasonsPlan([
    { category: "精选酒店", text: "B" },
    { category: "优选行程", text: "A" },
    { category: "缤纷景点", text: "C" },
  ]);
  assert.equal(plan.length, 3);
  assert.equal(plan[0]?.category, "精选酒店");
});

test("少于 3 项抛错", () => {
  assert.throws(() => buildRecommendationReasonsPlan([
    { category: "优选行程", text: "A" },
  ]), /3 项/);
});

test("非白名单分类抛错", () => {
  assert.throws(() => buildRecommendationReasonsPlan([
    { category: "超值套餐", text: "非法" },
    { category: "精选酒店", text: "B" },
    { category: "缤纷景点", text: "C" },
  ]), /白名单/);
});

test("重复分类抛错", () => {
  assert.throws(() => buildRecommendationReasonsPlan([
    { category: "优选行程", text: "A" },
    { category: "优选行程", text: "B" },
    { category: "缤纷景点", text: "C" },
  ]), /重复/);
});