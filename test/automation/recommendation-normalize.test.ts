import test from "node:test";
import assert from "node:assert/strict";
import {
  buildRecommendationReasonsPlan,
  normalizeVbkRecommendation,
} from "../../src/main/automation/ctrip/presentation/recommendations.js";

test("推荐理由把 VBK 不接受的常见标点归一为允许符号", () => {
  assert.equal(
    normalizeVbkRecommendation("半自助行程：上午游览；下午自由活动！"),
    "半自助行程，上午游览，下午自由活动",
  );
  assert.equal(normalizeVbkRecommendation("江城人文—跨江漫游。"), "江城人文-跨江漫游");
});

test("推荐理由写入计划使用归一后的平台文案", () => {
  const plan = buildRecommendationReasonsPlan([
    { category: "精选酒店", text: "住宿安排：邻近核心片区。" },
    { category: "特色美食", text: "本地风味；按需品尝。" },
    { category: "服务保障", text: "接送清晰！衔接顺畅。" },
  ]);
  assert.deepEqual(plan.map((item) => item.text), [
    "住宿安排，邻近核心片区",
    "本地风味，按需品尝",
    "接送清晰，衔接顺畅",
  ]);
});

test("推荐理由不静默改写敏感词或截断超长文本", () => {
  assert.equal(normalizeVbkRecommendation("首次到访"), "首次到访");
  assert.throws(
    () => buildRecommendationReasonsPlan([
      { category: "精选酒店", text: "x".repeat(100) },
      { category: "特色美食", text: "y" },
      { category: "服务保障", text: "z" },
    ]),
    /超过 VBK 长度限制.*重新生成/,
  );
});

test("推荐理由文本不是 string 时直接拒绝", () => {
  assert.throws(
    () => buildRecommendationReasonsPlan([
      { category: "精选酒店", text: 123 as unknown as string },
      { category: "特色美食", text: "y" },
      { category: "服务保障", text: "z" },
    ]),
    /文本必须是 string/,
  );
});
