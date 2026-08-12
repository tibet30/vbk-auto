import test from "node:test";
import assert from "node:assert/strict";
import { sanitiseModuleValue } from "../../src/main/planning/stage-runner.js";
import {
  buildVbkCopyPolicyPrompt,
  findVbkCopyBadCase,
} from "../../src/main/planning/vbk-copy-policy.js";

test("VBK bad case 同时进入 AI 提示词与本地输出门禁", () => {
  const prompt = buildVbkCopyPolicyPrompt();
  assert.match(prompt, /首发/);
  assert.match(prompt, /开班/);

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

test("不含 bad case 的合规文案正常通过", () => {
  const result = sanitiseModuleValue("basicInfo", {
    subtitle: "西安精品私家团",
    province: "陕西省",
    operationNotes: "本产品开班日期以确认单为准",
  });
  assert.equal(result.ok, true);
});
