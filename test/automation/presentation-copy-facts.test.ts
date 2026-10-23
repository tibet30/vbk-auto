import assert from "node:assert/strict";
import test from "node:test";
import { applySensitivePresentationRewrite } from "../../src/main/automation/automation.main/presentation-sensitive-rewrite.js";

function product(copy: string) {
  return {
    presentation: {
      recommendationCategory: "优选行程",
      recommendation: copy,
      features: "行程内容以确认方案为准。",
      recommendations: [
        { category: "缤纷景点", text: "按照每日行程安排游览当地景观，体验目的地自然风貌与人文特色" },
        { category: "精选酒店", text: "住宿由平台按既定规则匹配，结合每日路线安排入住城市" },
        { category: "服务保障", text: "行程服务以已确认方案为准，协助安排旅途衔接与咨询事项" },
      ],
    },
  };
}

function rewrite(value: ReturnType<typeof product>, copy: string) {
  return applySensitivePresentationRewrite(value, {
    reply: "", questions: [], researchTasks: [],
    patch: [{ op: "replace", path: "/presentation", value: { ...value.presentation, recommendation: copy } }],
  }, ["recommendation"], ["平台词"]);
}

test("图文改写拒绝交换早餐权益受益主体", () => {
  const value = product("成人含早，儿童早餐自理，行程安排以确认方案为准。");
  assert.throws(
    () => rewrite(value, "儿童含早，成人早餐自理，行程安排以确认方案为准。"),
    /改变了已确认的权益或数值.*返回规划重新确认/,
  );
});

test("无标点连接的成人儿童权益仍分别绑定主体", () => {
  const value = product("成人含早而儿童早餐自理，行程安排以确认方案为准。");
  assert.throws(
    () => rewrite(value, "儿童含早而成人早餐自理，行程安排以确认方案为准。"),
    /改变了已确认的权益或数值.*返回规划重新确认/,
  );
});

test("含早与含餐缩写不能在成人儿童之间互换", () => {
  const value = product("成人含早儿童含餐，行程安排以确认方案为准。");
  assert.throws(
    () => rewrite(value, "儿童含早成人含餐，行程安排以确认方案为准。"),
    /改变了已确认的权益或数值.*返回规划重新确认/,
  );
});

test("图文改写拒绝将不赠送保险改为赠送保险", () => {
  const value = product("本产品不赠送保险，行程安排以确认方案为准。");
  assert.throws(
    () => rewrite(value, "本产品赠送保险，行程安排以确认方案为准。"),
    /改变了已确认的权益或数值.*返回规划重新确认/,
  );
});

test("图文改写把未赠送识别为否定关系", () => {
  const value = product("本产品未赠送保险，行程安排以确认方案为准。");
  assert.throws(
    () => rewrite(value, "本产品赠送保险，行程安排以确认方案为准。"),
    /改变了已确认的权益或数值.*返回规划重新确认/,
  );
});

test("图文改写拒绝删除免费门票的否定关系", () => {
  const value = product("本产品不免费门票，行程安排以确认方案为准。");
  assert.throws(
    () => rewrite(value, "本产品免费门票，行程安排以确认方案为准。"),
    /改变了已确认的权益或数值.*返回规划重新确认/,
  );
});

test("图文改写拒绝删除提供早餐的否定关系", () => {
  const value = product("成人不提供早餐，行程安排以确认方案为准。");
  assert.throws(
    () => rewrite(value, "成人提供早餐，行程安排以确认方案为准。"),
    /改变了已确认的权益或数值.*返回规划重新确认/,
  );
});

test("图文改写拒绝交换成人儿童的数值", () => {
  const value = product("成人100元儿童50元，行程安排以确认方案为准。");
  assert.throws(
    () => rewrite(value, "成人50元儿童100元，行程安排以确认方案为准。"),
    /改变了已确认的权益或数值.*返回规划重新确认/,
  );
});

test("图文改写拒绝删除共享权益中的主体", () => {
  const value = product("成人和儿童含早，行程安排以确认方案为准。");
  assert.throws(
    () => rewrite(value, "儿童含早，行程安排以确认方案为准。"),
    /改变了已确认的权益或数值.*返回规划重新确认/,
  );
});

test("图文改写拒绝无显式主体时交换不同权益的数值", () => {
  const value = product("门票100元、早餐50元，行程安排以确认方案为准。");
  assert.throws(
    () => rewrite(value, "门票50元、早餐100元，行程安排以确认方案为准。"),
    /改变了已确认的权益或数值.*返回规划重新确认/,
  );
});

test("图文改写允许不改变事实的宣传措辞与标点调整", () => {
  const value = product("成人含早，儿童早餐自理；行程安排以确认方案为准。");
  rewrite(value, "成人含早，儿童早餐自理。请按确认方案安排行程。");
  assert.equal(value.presentation.recommendation, "成人含早，儿童早餐自理。请按确认方案安排行程。");
});

test("图文改写允许包含与含的等价措辞", () => {
  const value = product("成人包含早餐，儿童早餐自理，行程安排以确认方案为准。");
  rewrite(value, "成人含早餐，儿童早餐自理，行程安排以确认方案为准。");
  assert.equal(value.presentation.recommendation, "成人含早餐，儿童早餐自理，行程安排以确认方案为准。");
});

test("图文改写允许含早展开及自理前后置", () => {
  const value = product("成人含早，儿童早餐自理，行程安排以确认方案为准。");
  rewrite(value, "成人含早餐，儿童自理早餐，行程安排以确认方案为准。");
  assert.equal(value.presentation.recommendation, "成人含早餐，儿童自理早餐，行程安排以确认方案为准。");
});

test("图文改写允许纯措辞变化并保留无主体事实", () => {
  const value = product("安排2段服务衔接，含早，保险说明以已确认内容为准。");
  rewrite(value, "提供2段行程衔接，含早，保险说明遵循已确认内容。");
  assert.equal(value.presentation.recommendation, "提供2段行程衔接，含早，保险说明遵循已确认内容。");
});
