import assert from "node:assert/strict";
import test from "node:test";
import { sanitiseModuleValue } from "../../src/main/planning/stage-runner.js";

test("presentation 自动把模型输出的 features 对象修复为安全 HTML", () => {
  const result = sanitiseModuleValue("presentation", {
    recommendationCategory: "优选行程",
    recommendation: "日喀则人文精华两日游",
    recommendations: [
      { category: "优选行程", text: "江孜与日喀则人文串联" },
      { category: "缤纷景点", text: "庄园古堡寺院层次丰富" },
      { category: "服务保障", text: "专车接送并配讲解" },
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
