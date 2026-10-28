import test from "node:test";
import assert from "node:assert/strict";
import {
  buildRecommendationReasonsPlan,
  normalizeVbkRecommendation,
} from "../../src/main/automation/ctrip/presentation/recommendations.js";
import { sanitiseModuleValue } from "../../src/main/planning/stage-runner.js";
import { hasValidVbkRecommendationLength, vbkRecommendationCharacterLength } from "../../src/main/planning/vbk-recommendation-length.js";

test("推荐理由把 VBK 不接受的常见标点归一为允许符号", () => {
  assert.equal(
    normalizeVbkRecommendation("半自助行程：上午游览；下午自由活动！"),
    "半自助行程，上午游览，下午自由活动",
  );
  assert.equal(normalizeVbkRecommendation("江城人文—跨江漫游。"), "江城人文-跨江漫游");
});

test("推荐理由写入计划使用归一后的平台文案", () => {
  const plan = buildRecommendationReasonsPlan([
    { category: "精选酒店", text: "住宿安排，邻近核心片区，方便每日出行与休息，整体体验更舒适" },
    { category: "特色美食", text: "本地风味按需品尝，覆盖宽窄巷子与本地老店特色小吃，体验更丰富" },
    { category: "服务保障", text: "接送清晰，衔接顺畅，全程专车衔接酒店与景区，避开自行换乘的繁琐" },
  ]);
  assert.deepEqual(plan.map((item) => item.text), [
    "住宿安排，邻近核心片区，方便每日出行与休息，整体体验更舒适",
    "本地风味按需品尝，覆盖宽窄巷子与本地老店特色小吃，体验更丰富",
    "接送清晰，衔接顺畅，全程专车衔接酒店与景区，避开自行换乘的繁琐",
  ]);
});

test("推荐理由不改写敏感词，并把超长文本确定性收敛到完整分句", () => {
  assert.equal(normalizeVbkRecommendation("首次到访"), "首次到访");
  const plan = buildRecommendationReasonsPlan([
    { category: "精选酒店", text: "入住核心片区舒适酒店，步行即可抵达热门商圈，方便每天出行与休息，每日行程结束后可以从容休息" },
    { category: "特色美食", text: "本地老店特色小吃与简餐，餐食与景点结合，体验更丰富，按需品尝" },
    { category: "服务保障", text: "全程专车衔接酒店与宽窄巷子，避开自行换乘的繁琐，2天出行更安心" },
  ]);
  assert.equal(plan[0]?.text, "入住核心片区舒适酒店，步行即可抵达热门商圈，方便每天出行与休息");
  assert.ok(vbkRecommendationCharacterLength(plan[0]!.text) <= 80);
  assert.ok(hasValidVbkRecommendationLength(plan[0]!.text));
});

test("平台字符宽度合规的推荐理由超过规划字节预算时仍保留完整原文", () => {
  const text = "入住核心片区舒适酒店，步行即可抵达热门商圈，方便每天出行与休息";
  assert.ok(new TextEncoder().encode(text).length > 80);
  assert.ok(hasValidVbkRecommendationLength(text));
  assert.equal(normalizeVbkRecommendation(text), text);
  const plan = buildRecommendationReasonsPlan([
    { category: "精选酒店", text },
    { category: "特色美食", text: "本地老店特色小吃与简餐，餐食与景点结合，体验更丰富，按需品尝" },
    { category: "服务保障", text: "全程专车衔接酒店与宽窄巷子，避开自行换乘的繁琐，2天出行更安心" },
  ]);
  assert.equal(plan[0]?.text, text);
});

test("没有可保留完整分句时抛错，录入阶段可见失败而不替换成泛化短句", () => {
  assert.throws(() => normalizeVbkRecommendation("无标点的超长推荐理由".repeat(8)), /推荐理由超过 84 平台字符且无法按分句截短/);
  assert.throws(() => buildRecommendationReasonsPlan([
    { category: "服务保障", text: "无标点的超长推荐理由".repeat(8) },
    { category: "精选酒店", text: "成都市区5钻酒店连住1晚，步行可达春熙路，夜游太古里更方便" },
    { category: "特色美食", text: "宽窄巷子可品尝龙抄手、钟水饺等成都小吃，午餐就近安排" },
  ]), /第 1 项超过 84 平台字符且无法按分句截短.*返回规划重新改写/);
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

test("presentation 生成出口先收短超长推荐理由再通过 schema", () => {
  const result = sanitiseModuleValue("presentation", {
    recommendationCategory: "优选行程",
    recommendation: "无锡三日游览安排清晰。",
    recommendations: [
      { category: "缤纷景点", text: "串联太湖湖滨与梁溪老城，集中体验无锡山水与人文风貌，三日游览节奏从容舒适" },
      { category: "精选酒店", text: "无锡市区酒店连住2晚，含双早，步行可达南长街夜游古运河" },
      { category: "服务保障", text: "3天专车接送，无锡站接团后直达鼋头渚，行李随车不必换乘" },
    ],
    features: "<p>三日私家团行程。</p>",
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const presentation = result.value as { recommendations: Array<{ text: string }> };
  assert.equal(presentation.recommendations[0]?.text, "串联太湖湖滨与梁溪老城，集中体验无锡山水与人文风貌，三日游览节奏从容舒适");
  assert.ok(vbkRecommendationCharacterLength(presentation.recommendations[0]!.text) <= 84);
});
