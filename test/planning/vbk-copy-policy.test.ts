import test from "node:test";
import assert from "node:assert/strict";
import { sanitiseModuleValue } from "../../src/main/planning/stage-runner.js";
import {
  buildVbkCopyPolicyPrompt,
  findAllVbkCopyBadCases,
  findVbkCopyBadCase,
} from "../../src/main/planning/vbk-copy-policy.js";
import { systemPrompt as legacySystemPrompt } from "../../src/main/minimax/minimax-constants.js";

test("VBK bad case 同时进入 AI 提示词与本地输出门禁", () => {
  const prompt = buildVbkCopyPolicyPrompt();
  assert.match(prompt, /首发/);
  assert.match(prompt, /开班/);
  assert.match(prompt, /首次/);
  assert.match(prompt, /主席/);
  assert.match(prompt, /第一（宣传排名用语）/);
  assert.match(prompt, /最（极限表达）/);
  assert.match(prompt, /导游否定描述/);
  assert.match(prompt, /官方 POI 身份字段 poiName 和 requestedName/);
  assert.match(legacySystemPrompt, /VBK 文案黑名单/);
  assert.match(legacySystemPrompt, /首次/);

  const hit = findVbkCopyBadCase({ operationNotes: "本产品首发日期待定" });
  assert.equal(hit?.path, "value.operationNotes");
  assert.equal(hit?.term, "首发");

  const result = sanitiseModuleValue("basicInfo", {
    subtitle: "西安精品私家团",
    province: "陕西省",
    operationNotes: "本产品首发日期待定",
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /文案黑名单.*首发.*开班/);
});

test("实跑敏感词与极限宣传进入黑名单，但行程序号不被误伤", () => {
  assert.equal(findVbkCopyBadCase("适合首次到访的游客")?.term, "首次");
  assert.equal(findVbkCopyBadCase("参观主席旧居")?.term, "主席");
  assert.equal(findVbkCopyBadCase("前往南普陀寺礼佛")?.term, "礼佛");
  assert.equal(findVbkCopyBadCase("登临长城之巅")?.term, "之巅");
  assert.equal(findVbkCopyBadCase("本地排名第一的路线")?.term, "第一（宣传排名用语）");
  assert.equal(findVbkCopyBadCase("提供最佳体验")?.term, "最（极限表达）");
  assert.equal(findVbkCopyBadCase("保存最完整的明代城墙")?.term, "最（极限表达）");
  assert.equal(findVbkCopyBadCase("唯一选择")?.term, "其他绝对化用语");
  assert.equal(findVbkCopyBadCase("全网零差评")?.term, "其他绝对化用语");
  assert.equal(findVbkCopyBadCase("不配随队导游", "value.presentation.features")?.term, "导游否定描述");
  assert.equal(findVbkCopyBadCase("第一天游览晋祠"), undefined);
  assert.equal(findVbkCopyBadCase("最后一天送站"), undefined);
  assert.equal(findVbkCopyBadCase("费用不含导游", "value.commercial.terms.exclusions"), undefined);
});

test("不含 bad case 的合规文案正常通过", () => {
  const result = sanitiseModuleValue("basicInfo", {
    subtitle: "西安精品私家团",
    province: "陕西省",
    operationNotes: "本产品开班日期以确认单为准",
  });
  assert.equal(result.ok, true);
});

test("官方 POI 名称保留身份，但自由文案仍拦截敏感词", () => {
  assert.equal(findVbkCopyBadCase("毛泽东青年艺术雕塑", "value.itinerary[0].pois[0].poiName"), undefined);
  assert.equal(findVbkCopyBadCase("毛泽东青年艺术雕塑", "value.poiCandidates[0].requestedName"), undefined);
  assert.equal(findVbkCopyBadCase("瞻仰毛泽东青年艺术雕塑", "value.itinerary[0].description")?.term, "毛泽东");
});

test("全产品扫描一次返回所有命中路径，避免修一个词再跑一轮", () => {
  const hits = findAllVbkCopyBadCases({
    presentation: { recommendation: "首次到访，提供最佳体验" },
    itinerary: [{ description: "前往南普陀寺礼佛" }],
  });
  assert.deepEqual(hits.map((hit) => [hit.path, hit.term]), [
    ["value.presentation.recommendation", "首次"],
    ["value.presentation.recommendation", "最（极限表达）"],
    ["value.itinerary[0].description", "礼佛"],
  ]);
});

test("模块门禁一次返回同一模块内全部文案命中", () => {
  const result = sanitiseModuleValue("presentation", {
    recommendationCategory: "优选行程",
    recommendation: "首次到访，提供最佳体验",
    recommendations: [
      { category: "优选行程", text: "合规" },
      { category: "精选酒店", text: "合规" },
      { category: "缤纷景点", text: "合规" },
    ],
    features: "合规",
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.reason, /value\.recommendation.*首次/);
    assert.match(result.reason, /value\.recommendation.*最（极限表达）/);
    assert.match(result.reason, /改写为/);
  }
});
