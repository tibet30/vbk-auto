import test from "node:test";
import assert from "node:assert/strict";
import {
  extractSensitiveWords,
  applySensitiveItineraryRewrite,
  findSensitiveItineraryPaths,
} from "../../src/main/automation/automation.main/itinerary-sensitive-rewrite.js";

function product() {
  return {
    itinerary: [
      {
        day: 1,
        title: "第一天",
        spots: [{ name: "王家大院", poiId: 1, poiName: "王家大院" }],
        description: "挑战巅峰景观，尽量轻装上阵。",
        hotel: "",
        meals: "含早",
      },
      {
        day: 2,
        title: "第二天",
        spots: [{ name: "平遥古城", poiId: 2, poiName: "平遥古城" }],
        description: "继续体验当地文化。",
        hotel: "",
        meals: "含餐",
      },
    ],
    operations: {},
  };
}

test("仅定位实际命中的行程描述字段", () => {
  const target = product();
  assert.deepEqual(
    findSensitiveItineraryPaths(target, ["巅峰", "其他"]),
    ["/itinerary/0/description"],
  );
});

test("AI 重写后仅更新命中的行程描述，其他天保留", () => {
  const value = product();
  applySensitiveItineraryRewrite(
    value,
    {
      reply: "已重写",
      patch: [
        {
          op: "replace",
          path: "/itinerary/0/description",
          value: "挑战高峰景观，尽量轻装上阵。",
        },
      ],
      questions: [],
      researchTasks: [],
    },
    ["巅峰"],
  );

  assert.equal(value.itinerary[0].description, "挑战高峰景观，尽量轻装上阵。");
  assert.equal(value.itinerary[1].description, "继续体验当地文化。");
});

test("AI 重写后仍含敏感词时拒绝落库", () => {
  const value = product();
  assert.throws(() => {
    applySensitiveItineraryRewrite(
      value,
      {
        reply: "已重写",
        patch: [{
          op: "replace",
          path: "/itinerary/0/description",
          value: "挑战巅峰景观，冲击极限。",
        }],
        questions: [],
        researchTasks: [],
      },
      ["巅峰"],
    );
  }, /仍包含平台非法关键词：巅峰/);
});

test("AI 返回未修改命中字段时报错", () => {
  const value = product();
  assert.throws(() => {
    applySensitiveItineraryRewrite(
      value,
      {
        reply: "已重写",
        patch: [{
          op: "replace",
          path: "/itinerary/0/description",
          value: value.itinerary[0].description,
        }],
        questions: [],
        researchTasks: [],
      },
      ["巅峰"],
    );
  }, /AI 未重写命中的行程描述字段/);
});

test("支持解析含空格与结尾提示的非法关键词文案", () => {
  assert.deepEqual(extractSensitiveWords("保存第1天行程描述，提示非法关键词： 巅峰 ，请修改后重新提交"), ["巅峰"]);
  assert.deepEqual(
    extractSensitiveWords("VBK 行程校验(saveType=3)失败：非法关键词：巅峰、极端 ；请修改"),
    ["巅峰", "极端"],
  );
});
