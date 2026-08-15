import test from "node:test";
import assert from "node:assert/strict";
import { sanitiseModuleValue } from "../../src/main/planning/stage-runner.js";
import {
  buildVbkCopyPolicyPrompt,
  findVbkCopyBadCase,
} from "../../src/main/planning/vbk-copy-policy.js";
import { systemPrompt as legacySystemPrompt } from "../../src/main/minimax/minimax-constants.js";

test("VBK bad case 同时进入 AI 提示词与本地输出门禁", () => {
  const prompt = buildVbkCopyPolicyPrompt();
  assert.match(prompt, /首发/);
  assert.match(prompt, /开班/);
  assert.match(prompt, /首次/);
  assert.match(prompt, /第一（宣传排名用语）/);
  assert.match(prompt, /最（极限表达）/);
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
  assert.equal(findVbkCopyBadCase("本地排名第一的路线")?.term, "第一（宣传排名用语）");
  assert.equal(findVbkCopyBadCase("提供最佳体验")?.term, "最（极限表达）");
  assert.equal(findVbkCopyBadCase("保存最完整的明代城墙")?.term, "最（极限表达）");
  assert.equal(findVbkCopyBadCase("唯一选择")?.term, "其他绝对化用语");
  assert.equal(findVbkCopyBadCase("全网零差评")?.term, "其他绝对化用语");
  assert.equal(findVbkCopyBadCase("第一天游览晋祠"), undefined);
  assert.equal(findVbkCopyBadCase("最后一天送站"), undefined);
});

test("不含 bad case 的合规文案正常通过", () => {
  const result = sanitiseModuleValue("basicInfo", {
    subtitle: "西安精品私家团",
    province: "陕西省",
    operationNotes: "本产品开班日期以确认单为准",
  });
  assert.equal(result.ok, true);
});
