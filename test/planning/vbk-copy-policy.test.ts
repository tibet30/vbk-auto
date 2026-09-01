import test from "node:test";
import assert from "node:assert/strict";
import { executeStageOutput, sanitiseModuleValue } from "../../src/main/planning/stage-runner.js";
import {
  VBK_COPY_BAD_CASES,
  buildVbkCopyPolicyPrompt,
  findAllVbkCopyBadCases,
  findVbkCopyBadCase,
  repairVbkCopyPolicyValue,
  sanitiseUserIdeaForAi,
} from "../../src/main/planning/vbk-copy-policy.js";
import { systemPrompt as legacySystemPrompt } from "../../src/main/minimax/minimax-constants.js";
import { composePlanningSystemPrompt } from "../../src/main/planning/adapters/planning-prompt.js";

test("VBK bad case 同时进入 AI 提示词与本地输出门禁", () => {
  const prompt = buildVbkCopyPolicyPrompt();
  assert.match(prompt, /首发/);
  assert.match(prompt, /开班/);
  assert.match(prompt, /首次/);
  assert.match(prompt, /首选/);
  assert.match(prompt, /主席/);
  assert.match(prompt, /第一（宣传排名用语）/);
  assert.match(prompt, /最（极限表达）/);
  assert.match(prompt, /导游否定描述/);
  assert.match(prompt, /官方 POI 身份字段 poiName 和 requestedName/);
  assert.match(legacySystemPrompt, /VBK 文案黑名单/);
  assert.match(legacySystemPrompt, /首次/);

  const planningPrompt = composePlanningSystemPrompt("presentation");
  assert.match(planningPrompt, /VBK 文案黑名单/);
  assert.match(planningPrompt, /首次/);
  assert.match(planningPrompt, /初到/);
  for (const badCase of VBK_COPY_BAD_CASES) {
    assert.ok(planningPrompt.includes(badCase.term), `真实规划提示漏掉黑名单词：${badCase.term}`);
  }

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
  assert.equal(findVbkCopyBadCase("度假首选路线")?.term, "首选");
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

test("用户原始想法保留行程语义，但提交 AI 前移除绝对化用语", () => {
  const sanitised = sanitiseUserIdeaForAi("第一天去晋祠，安排全网最佳、唯一的深度体验，保证满意。");
  assert.match(sanitised, /第一天去晋祠/);
  assert.doesNotMatch(sanitised, /全网|最佳|唯一|保证满意/);
  assert.equal(sanitiseUserIdeaForAi("最后一天自由活动"), "最后一天自由活动");
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

test("规划阶段用已验证替代词修复首次文案后才写入", async () => {
  const writes: unknown[] = [];
  const presentation = {
    recommendationCategory: "优选行程",
    recommendation: "首次到访西藏，行程安排清晰",
    recommendations: [
      { category: "优选行程", text: "高原风光与城市文化结合" },
      { category: "精选酒店", text: "住宿安排与每日行程衔接" },
      { category: "缤纷景点", text: "预留舒缓节奏适应高原环境" },
    ],
    features: "<p><strong>行程节奏：</strong>预留适应时间。</p>",
  };
  const result = await executeStageOutput({
    stage: "presentation",
    localProductId: "copy-policy-fallback",
    runtime: {
      async writeModule(_id: string, _module: string, _path: string, value: unknown) {
        writes.push(value);
        return { ok: true };
      },
    } as any,
    output: { reply: "产品图文", modules: [{ module: "presentation", status: "accepted", value: presentation }] },
  });

  assert.equal(result.rejected.length, 0);
  assert.equal(result.accepted.length, 1);
  assert.deepEqual(writes, [{ ...presentation, recommendation: "初到西藏，行程安排清晰" }]);
  assert.equal(sanitiseModuleValue("presentation", writes[0]).ok, true, "写入前后的门禁仍应通过");
});

test("确定性修复保留官方 POI 身份字段，并让未消除的命中继续拒绝", () => {
  const value = {
    itinerary: [{ description: "首次到访", spots: [{ poiName: "首次公园", requestedName: "首次公园" }] }],
  };
  const repaired = repairVbkCopyPolicyValue(value);
  assert.deepEqual(repaired, {
    itinerary: [{ description: "初到", spots: [{ poiName: "首次公园", requestedName: "首次公园" }] }],
  });
  assert.equal(findVbkCopyBadCase(repaired)?.path, "value.itinerary[0].spots[0].poiName");
});

test("真实图文非法词首选会在写入前确定性改写", () => {
  const repaired = repairVbkCopyPolicyValue({ presentation: { features: "云南度假首选" } });
  assert.deepEqual(repaired, { presentation: { features: "云南度假之选" } });
  assert.equal(findVbkCopyBadCase(repaired), undefined);
});

test("文案修复后仍有 schema 问题时不得写入", async () => {
  let writes = 0;
  const result = await executeStageOutput({
    stage: "presentation",
    localProductId: "copy-policy-structural-reject",
    runtime: {
      async writeModule() {
        writes += 1;
        return { ok: true };
      },
    } as any,
    output: {
      reply: "产品图文",
      modules: [{
        module: "presentation",
        status: "accepted",
        value: {
          recommendationCategory: "优选行程",
          recommendation: "首次到访西藏",
          recommendations: [],
          features: "<p>合规</p>",
        },
      }],
    },
  });

  assert.equal(writes, 0);
  assert.equal(result.accepted.length, 0);
  assert.match(result.rejected[0]?.reason ?? "", /recommendations.*>=3 items/);
});
