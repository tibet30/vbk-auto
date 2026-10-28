import assert from "node:assert/strict";
import test from "node:test";
import { applySensitivePresentationRewrite } from "../../src/main/automation/automation.main/presentation-sensitive-rewrite.js";
import { buildRecommendationReasonsPlan } from "../../src/main/automation/ctrip/presentation/recommendations.js";
import { poiIdentityNames } from "../../src/main/planning/vbk-copy-identity.js";

const harbin = {
  itinerary: [{
    day: 2,
    spots: [
      { name: "龙江第一湾", poiName: "龙江第一湾风景区", poiId: 91861 },
      { name: "中国最北点", poiName: "中国最北点", poiId: 56810159 },
    ],
  }],
  presentation: {
    recommendationCategory: "缤纷体验",
    recommendation: "北境边境线与冰雪玩法慢游",
    features: "<p><strong>路线：</strong>串联龙江第一湾风景区与中国最北点。</p>",
    recommendations: [
      { category: "缤纷体验", text: "串联龙江第一湾风景区与中国最北点，按每日路线安排游览，结合实际行程体验当地风貌与特色" },
      { category: "服务保障", text: "一单一团配合线上管家服务，协助行程衔接并响应旅途中的常见咨询" },
      { category: "精选酒店", text: "住宿由平台按三钻四钻五钻规则自动匹配，结合每日路线安排入住城市" },
    ],
  },
};

test("哈尔滨官方 POI 全名在推荐理由中保留，名称外的排名宣传仍被拦截", () => {
  const names = poiIdentityNames({ itinerary: harbin.itinerary });
  assert.doesNotThrow(() => buildRecommendationReasonsPlan(harbin.presentation.recommendations, names));
  const ranked = structuredClone(harbin.presentation.recommendations);
  ranked[0]!.text += "，当地排名第一";
  assert.throws(
    () => buildRecommendationReasonsPlan(ranked, names),
    /第一（宣传排名用语）/,
  );
  const best = structuredClone(harbin.presentation.recommendations);
  best[0]!.text += "，提供最佳体验";
  assert.throws(() => buildRecommendationReasonsPlan(best, names), /最（极限表达）/);
});

test("推荐理由裁剪不得丢失末尾官方 POI 名", () => {
  const names = poiIdentityNames({ itinerary: harbin.itinerary });
  const long = structuredClone(harbin.presentation.recommendations);
  long[0]!.text = `${"沿途景观与地方文化体验内容丰富，".repeat(8)}前往龙江第一湾风景区`;
  assert.throws(
    () => buildRecommendationReasonsPlan(long, names),
    /裁剪后会丢失官方 POI 名.*必须返回规划重新改写/,
  );
});

test("推荐理由超长原文末尾黑名单不得被裁剪吞掉", () => {
  const names = poiIdentityNames({ itinerary: harbin.itinerary });
  const long = structuredClone(harbin.presentation.recommendations);
  long[0]!.text = `${"沿途景观与地方文化体验内容丰富，".repeat(8)}当地排名第一`;
  assert.throws(
    () => buildRecommendationReasonsPlan(long, names),
    /第一（宣传排名用语）/,
  );
});

test("图文候选不得删除或改写命中字段中已有的完整官方 POI 名", () => {
  const value = structuredClone(harbin);
  assert.throws(() => applySensitivePresentationRewrite(value, {
    reply: "",
    questions: [],
    researchTasks: [],
    patch: [{ op: "replace", path: "/presentation", value: {
      ...value.presentation,
      recommendations: [
        { ...value.presentation.recommendations[0], text: "串联龙江重点湾与中国更北点，按每日路线安排游览，结合实际行程体验当地风貌与特色" },
        ...value.presentation.recommendations.slice(1),
      ],
    } }],
  }, ["recommendations.0.text"], ["平台词"]), /不得增加、删除或修改.*官方 POI 引用/);
});

test("图文候选不得新增另一个当前行程 POI 引用", () => {
  const value = structuredClone(harbin);
  value.presentation.recommendations[0]!.text = "围绕龙江第一湾风景区安排游览，结合每日景点说明了解行程内容与游览顺序";
  const next = value.presentation.recommendations[0]!.text.replace("安排游览", "与中国最北点安排游览");
  assert.throws(() => applySensitivePresentationRewrite(value, {
    reply: "", questions: [], researchTasks: [],
    patch: [{ op: "replace", path: "/presentation", value: { ...value.presentation,
      recommendations: [{ ...value.presentation.recommendations[0], text: next }, ...value.presentation.recommendations.slice(1)] } }],
  }, ["recommendations.0.text"], ["平台词"]), /不得增加、删除或修改.*官方 POI 引用/);
});

test("图文候选删除已确认的数值、含餐或保险事实时必须退回规划", () => {
  for (const removed of ["2", "含早", "保险"]) {
    const value = structuredClone(harbin);
    value.presentation.recommendations[1]!.text = "安排2段服务衔接，含早，保险说明以已确认内容为准";
    const next = value.presentation.recommendations[1]!.text.replace(removed, "");
    assert.throws(() => applySensitivePresentationRewrite(value, {
      reply: "",
      questions: [],
      researchTasks: [],
      patch: [{ op: "replace", path: "/presentation", value: {
        ...value.presentation,
        recommendations: [
          value.presentation.recommendations[0],
          { ...value.presentation.recommendations[1], text: next },
          value.presentation.recommendations[2],
        ],
      } }],
    }, ["recommendations.1.text"], ["平台词"]), /改变了已确认的权益或数值.*返回规划重新确认/);
  }
});

test("图文候选只改自由措辞且保留事实 token 时允许应用", () => {
  const value = structuredClone(harbin);
  value.presentation.recommendations[1]!.text = "安排2段服务衔接，含早，保险说明以已确认内容为准";
  applySensitivePresentationRewrite(value, {
    reply: "",
    questions: [],
    researchTasks: [],
    patch: [{ op: "replace", path: "/presentation", value: {
      ...value.presentation,
      recommendations: [
        value.presentation.recommendations[0],
        { ...value.presentation.recommendations[1], text: "提供2段行程衔接，含早，保险说明遵循已确认内容" },
        value.presentation.recommendations[2],
      ],
    } }],
  }, ["recommendations.1.text"], ["平台词"]);
  assert.match(value.presentation.recommendations[1]!.text, /提供2段行程衔接/);
});

test("图文候选保护权益极性、服务承诺和价签金额关系", () => {
  const cases = [
    ["含门票并含接送用车", "不含门票并含接送用车"],
    ["含门票并含接送用车", "含门票并不含接送用车"],
    ["含门票并含接送用车", "含门票并含接送不含用车"],
    ["一单一团配合线上管家服务", "配合行程服务"],
    ["成人5680元，儿童4180元", "成人4180元，儿童5680元"],
  ];
  for (const [before, after] of cases) {
    const value = structuredClone(harbin);
    value.presentation.recommendations[1]!.text = `${before}，按已确认方案提供行程衔接与旅途咨询`;
    assert.throws(() => applySensitivePresentationRewrite(value, {
      reply: "", questions: [], researchTasks: [],
      patch: [{ op: "replace", path: "/presentation", value: { ...value.presentation,
        recommendations: [value.presentation.recommendations[0],
          { ...value.presentation.recommendations[1], text: `${after}，按已确认方案提供行程衔接与旅途咨询` },
          value.presentation.recommendations[2]] } }],
    }, ["recommendations.1.text"], ["平台词"]), /改变了已确认的权益或数值/);
  }
});

test("已知词定位可忽略官方名内部命中，默认平台拒绝定位保持严格", async () => {
  const { findSensitivePresentationPaths } = await import("../../src/main/automation/automation.main/presentation-sensitive-rewrite.js");
  const value = structuredClone(harbin);
  assert.deepEqual(findSensitivePresentationPaths(value, ["第一"]), ["features", "recommendations.0.text"]);
  assert.deepEqual(findSensitivePresentationPaths(value, ["第一"], true), []);
  value.presentation.recommendations[0]!.text += "，排名第一";
  assert.deepEqual(findSensitivePresentationPaths(value, ["第一"], true), ["recommendations.0.text"]);
});

test("平台点名词在官方名内部时候选必须改述该名称，其他官方名仍须保留", () => {
  const value = structuredClone(harbin);
  value.presentation.recommendations[0]!.text = "首次串联龙江第一湾风景区与中国最北点，按每日路线安排游览并体验当地风貌";
  const patch = (text: string) => ({ reply: "", questions: [], researchTasks: [],
    patch: [{ op: "replace" as const, path: "/presentation", value: { ...value.presentation,
      features: "<p><strong>路线：</strong>串联黑龙江江湾景区与中国最北点。</p>",
      recommendations: [{ ...value.presentation.recommendations[0], text }, ...value.presentation.recommendations.slice(1)] } }] });
  assert.throws(() => applySensitivePresentationRewrite(structuredClone(value),
    patch("初到可串联龙江第一湾风景区与中国最北点，按每日路线安排游览并体验当地风貌"),
    ["features", "recommendations.0.text"], ["首次", "第一"]), /仍包含平台非法关键词：第一/);
  assert.throws(() => applySensitivePresentationRewrite(structuredClone(value),
    patch("初到可串联黑龙江江湾景区与漠河北端，按每日路线安排游览并体验当地风貌与特色"),
    ["features", "recommendations.0.text"], ["首次", "第一"]), /官方 POI 引用/);
  applySensitivePresentationRewrite(value,
    patch("初到可串联黑龙江江湾景区与中国最北点，按每日路线安排游览并体验当地风貌与特色"),
    ["features", "recommendations.0.text"], ["首次", "第一"]);
  assert.match(value.presentation.recommendations[0]!.text, /中国最北点/);
  assert.doesNotMatch(value.presentation.recommendations[0]!.text, /首次|第一/);
});
