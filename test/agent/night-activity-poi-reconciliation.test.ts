import test from "node:test";
import assert from "node:assert/strict";
import { poiResearchTaskSatisfaction } from "../../src/shared/research-task-satisfaction.js";
const task = { label: "核查 冷湖石油小镇 的 VBK POI 映射", type: "vbk" };
const activity = { time: "晚上", title: "冷湖石油小镇星空拍摄", detail: "夜间星空", type: "other" };
const verified = { name: "冷湖", poiName: "冷湖", poiId: 22881469, kind: "attraction" };
test("已保存的夜拍不需要额外景点POI，陈旧问题按非POI收敛", () => {
  assert.equal(poiResearchTaskSatisfaction(task, { itinerary: [{ spots: [verified], activities: [activity] }] }), "non_poi");
});
test("夜拍不能隐藏同名或当日未核验景点，不借用描述或其他活动类型", () => {
  for (const spots of [[{ name: "冷湖石油小镇", kind: "attraction" }], [{ name: "其他未核验景点", kind: "attraction" }]]) {
    assert.equal(poiResearchTaskSatisfaction(task, { itinerary: [{ spots, activities: [activity] }] }), null);
  }
  for (const change of [{ type: "visit" }, { time: "下午" }, { title: "冷湖石油小镇自由活动" }]) {
    assert.equal(poiResearchTaskSatisfaction(task, { itinerary: [{ spots: [verified], activities: [{ ...activity, ...change }] }] }), null);
  }
});
