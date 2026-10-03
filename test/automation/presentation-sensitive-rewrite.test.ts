import test from "node:test";
import assert from "node:assert/strict";
import {
  applySensitivePresentationRewrite,
  findSensitivePresentationPaths,
} from "../../src/main/automation/automation.main/presentation-sensitive-rewrite.js";

function product() {
  return {
    presentation: {
      recommendationCategory: "优选行程",
      recommendation: "适合首次到访太原的游客高效游览核心看点。",
      features: "私家团灵活自由，入住当地5钻酒店。",
      recommendations: [
        { category: "缤纷景点", text: "串联晋祠与山西博物院，感受当地人文历史与建筑景观" },
        { category: "精选酒店", text: "入住当地5钻酒店一晚，游览结束后返回酒店休息" },
        { category: "特色美食", text: "品尝地道晋菜与地方早餐，感受当地饮食文化" },
      ],
      cover: { source: "ctripLibrary", imageId: 42851842 },
    },
  };
}

test("敏感词只定位实际命中的产品图文字段", () => {
  const value = product();
  assert.deepEqual(findSensitivePresentationPaths(value, ["首次"]), ["recommendation"]);
});

test("敏感词重写使用平台字符宽度，中文超84字节仍可合法写入", () => {
  const value = product();
  const text = "当地景观".repeat(9);
  assert.ok(new TextEncoder().encode(text).length > 84);
  applySensitivePresentationRewrite(value, { reply: "", questions: [], researchTasks: [], patch: [{
    op: "replace", path: "/presentation", value: { ...value.presentation, recommendations: [
      { ...value.presentation.recommendations[0], text }, ...value.presentation.recommendations.slice(1),
    ] },
  }] }, ["recommendations.0.text"], []);
  assert.equal(value.presentation.recommendations[0].text, text);
  for (const invalid of ["短句", "景".repeat(43)]) {
    const before = structuredClone(value);
    assert.throws(() => applySensitivePresentationRewrite(value, { reply: "", patch: [{ op: "replace", path: "/presentation", value: {
      ...value.presentation, recommendations: [{ ...value.presentation.recommendations[0], text: invalid }, ...value.presentation.recommendations.slice(1)],
    } }] }, ["recommendations.0.text"], []), /30～84/);
    assert.deepEqual(value, before);
  }
});

test("AI 局部重写只更新命中字段，保留分类、其余文案和封面", () => {
  const value = product();
  const before = structuredClone(value.presentation);
  applySensitivePresentationRewrite(value, {
    reply: "已改写",
    patch: [{
      op: "replace",
      path: "/presentation",
      value: {
        ...before,
        recommendation: "适合希望集中游览太原核心看点的游客。",
        features: "AI 不应覆盖这段产品特点。",
      },
    }],
    questions: [],
    researchTasks: [],
  }, ["recommendation"], ["首次"]);

  assert.equal(value.presentation.recommendation, "适合希望集中游览太原核心看点的游客。");
  assert.equal(value.presentation.features, before.features);
  assert.deepEqual(value.presentation.recommendations, before.recommendations);
  assert.deepEqual(value.presentation.cover, before.cover);
});

test("AI 返回仍含非法关键词时拒绝落库", () => {
  const value = product();
  assert.throws(() => applySensitivePresentationRewrite(value, {
    reply: "已改写",
    patch: [{ op: "replace", path: "/presentation", value: value.presentation }],
    questions: [],
    researchTasks: [],
  }, ["recommendation"], ["首次"]), /仍包含平台非法关键词：首次/);
});

test("AI 不得用另一条极限宣传黑名单替换平台敏感词", () => {
  const value = product();
  assert.throws(() => applySensitivePresentationRewrite(value, {
    reply: "已改写",
    patch: [{
      op: "replace",
      path: "/presentation",
      value: { ...value.presentation, recommendation: "太原排名第一的私家团路线。" },
    }],
    questions: [],
    researchTasks: [],
  }, ["recommendation"], ["首次"]), /仍命中文案黑名单：第一/);
});

test("多个命中字段校验失败时完全不修改原产品", () => {
  const value = product();
  value.presentation.features = "特色江鲜风味";
  const before = structuredClone(value);
  assert.throws(() => applySensitivePresentationRewrite(value, {
    reply: "", questions: [], researchTasks: [], patch: [{ op: "replace", path: "/presentation", value: {
      ...value.presentation, recommendation: "适合初到太原的游客", features: "特色江鲜风味",
    } }],
  }, ["recommendation", "features"], ["首次", "江鲜"]), /江鲜/);
  assert.deepEqual(value, before);
});

test("改写拒绝新增权益，富文本在可见文本层定位", () => {
  const value = product();
  assert.throws(() => applySensitivePresentationRewrite(value, {
    reply: "", questions: [], researchTasks: [], patch: [{ op: "replace", path: "/presentation", value: {
      ...value.presentation, recommendation: "初到太原，免费含餐",
    } }],
  }, ["recommendation"], ["首次"]), /未经确认/);
  value.presentation.features = "<p>自由品尝江<strong>鲜</strong></p>";
  assert.deepEqual(findSensitivePresentationPaths(value, ["江鲜"]), ["features"]);
  value.presentation.features = "<p>自由品尝&#27743;&#x9c9c;</p>";
  assert.deepEqual(findSensitivePresentationPaths(value, ["江鲜"]), ["features"]);
});
