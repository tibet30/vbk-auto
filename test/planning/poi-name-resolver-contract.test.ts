import test from "node:test";
import assert from "node:assert/strict";
import {
  composePoiNameResolutionMessages,
  parsePoiNameToolArgs,
  poiNameToolSchema,
} from "../../src/main/planning/adapters/openai-compatible-adapter.js";

test("POI 名称解析使用严格单字段工具契约", () => {
  assert.equal(poiNameToolSchema.function.name, "submit_vbk_poi_name");
  assert.deepEqual(poiNameToolSchema.function.parameters.required, ["poiName"]);
  assert.equal(poiNameToolSchema.function.parameters.additionalProperties, false);
  assert.deepEqual(parsePoiNameToolArgs({ poiName: " 西安钟楼 " }), "西安钟楼");
  assert.equal(parsePoiNameToolArgs({ poiName: null }), null);
  assert.equal(parsePoiNameToolArgs({ poiName: 75682 }), null);
  assert.equal(parsePoiNameToolArgs({}), null);
});

test("POI 名称替换提示要求单点、同范围替代且重试换名", () => {
  const first = composePoiNameResolutionMessages({ destination: "西安", originalName: "回民街·钟鼓楼广场", attempt: 1, previousCandidates: [] });
  const retry = composePoiNameResolutionMessages({ destination: "西安", originalName: "回民街·钟鼓楼广场", attempt: 2, previousCandidates: ["回民街"] });

  assert.match(first[0].content, /真实、单一、适合替换原景点/);
  assert.match(first[0].content, /可游览地点实体名称/);
  assert.match(first[0].content, /不得输出机场、车站、码头、酒店、民宿、集合点/);
  assert.match(first[0].content, /同目的地\/同核心游览城市/);
  assert.match(first[0].content, /适合替换原景点/);
  assert.match(first[0].content, /详细街道地址/);
  assert.match(first[0].content, /从中选择一个最具代表性的主景点/);
  assert.match(first[0].content, /同主题或同片区的可游览景点/);
  assert.match(first[1].content, /未能通过 VBK suggestPoi 查询/);
  assert.match(first[1].content, /可替换它/);
  assert.match(retry[1].content, /已尝试且未命中的候选：回民街/);
  assert.match(retry[1].content, /必须给出与以上所有候选不同的单一 POI 名称/);
});
