import assert from "node:assert/strict";
import test from "node:test";
import { splitAgentReasoning, stripAgentReasoning } from "../../src/shared/agent-visible-text.js";

test("stripAgentReasoning 只保留对外回答", () => {
  assert.equal(stripAgentReasoning("<think>internal analysis</think>\n请补充套餐名称。"), "请补充套餐名称。");
  assert.equal(stripAgentReasoning("<think>unfinished"), "");
  assert.equal(stripAgentReasoning("正常回答"), "正常回答");
});

test("splitAgentReasoning 拆出思考与结果，并标记思考是否结束", () => {
  assert.deepEqual(splitAgentReasoning("<think>先核对景点</think>\n已更新行程。"), {
    reasoning: "先核对景点",
    answer: "已更新行程。",
    reasoningComplete: true,
  });
  assert.deepEqual(splitAgentReasoning("<think>还在想"), {
    reasoning: "还在想",
    answer: "",
    reasoningComplete: false,
  });
  assert.deepEqual(splitAgentReasoning("直接回答，无思考块"), {
    reasoning: "",
    answer: "直接回答，无思考块",
    reasoningComplete: true,
  });
});

test("思考进行中默认展开，结束后默认收起", async () => {
  const { shouldExpandAgentReasoning } = await import("../../src/shared/agent-visible-text.js");
  assert.equal(shouldExpandAgentReasoning({ streaming: true, reasoningComplete: false }), true);
  assert.equal(shouldExpandAgentReasoning({ streaming: true, reasoningComplete: true }), false);
  assert.equal(shouldExpandAgentReasoning({ streaming: false, reasoningComplete: false }), true);
  assert.equal(shouldExpandAgentReasoning({ streaming: false, reasoningComplete: true }), false);
});
