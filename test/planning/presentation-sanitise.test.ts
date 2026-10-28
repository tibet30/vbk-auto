import assert from "node:assert/strict";
import test from "node:test";
import { sanitiseModuleValue } from "../../src/main/planning/stage-runner.js";

test("presentation 自动把模型输出的 features 对象修复为安全 HTML", () => {
  const result = sanitiseModuleValue("presentation", {
    recommendationCategory: "优选行程",
    recommendation: "日喀则人文精华两日游",
    recommendations: [
      { category: "优选行程", text: "江孜宗山古堡与日喀则扎什伦布寺串联，2天读懂后藏人文" },
      { category: "缤纷景点", text: "帕拉庄园看旧时庄园生活，白居寺十万佛塔层层登高" },
      { category: "服务保障", text: "日喀则火车站接送站，全程专车往返江孜无需换乘" },
    ],
    features: {
      sections: [
        { title: "人文深度", text: "帕拉庄园、宗山古堡与白居寺串联" },
        { title: "省心服务", text: "火车站接送与当地四钻住宿" },
      ],
    },
    cover: {
      source: "ctripLibrary",
      poi: "宗山抗英遗址-江孜宗山古堡",
      description: "江孜古堡封面",
      minQuality: 3,
    },
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(typeof (result.value as Record<string, unknown>).features, "string");
  assert.match(String((result.value as Record<string, unknown>).features), /<p>人文深度：/);
});
