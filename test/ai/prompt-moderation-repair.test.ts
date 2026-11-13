import test from "node:test";
import assert from "node:assert/strict";
import {
  attemptWithPromptRepair,
  sanitisePromptMessages,
  sanitisePromptText,
} from "../../src/main/ai/prompt-moderation-repair.js";
import { buildVbkCopyPolicyPrompt } from "../../src/main/planning/vbk-copy-policy.js";

const moderationError = Object.assign(new Error("422 input new_sensitive (1026)"), { status: 422 });

test("修复等级 0/1/2 逐级降低 prompt 的敏感字面量", () => {
  const policy = buildVbkCopyPolicyPrompt();
  const text = `规则：\n${policy}\n补充：禁止词「毛泽东」\n上一轮失败原因：命中「主席」`;

  // 正常 prompt 已不含政治字面量；这里额外拼入回灌文本，验证修复仍能兜住历史/平台学到的字面量。
  assert.match(sanitisePromptText(text, 0), /「主席」/);

  assert.match(sanitisePromptText(text, 0), /毛泽东/);
  const level1 = sanitisePromptText(text, 1);
  assert.doesNotMatch(level1, /毛泽东/);
  assert.doesNotMatch(level1, /「主席」/);
  assert.match(level1, /政治人物姓名/);
  assert.match(level1, /领导职务称谓/);
  assert.ok(level1.includes(policy.split("「毛泽东」")[0] ?? ""), "等级 1 应只替换字面量，保留黑名单结构");

  const level2 = sanitisePromptText(text, 2);
  assert.doesNotMatch(level2, /毛泽东/);
  assert.ok(!level2.includes(policy), "等级 2 应整段移除 VBK 文案黑名单");
  assert.match(level2, /VBK 文案限制/);
  assert.match(level2, /官方 POI 身份字段 poiName/);
});

test("sanitisePromptMessages 只改文本内容，不动 tool_call 等结构字段", () => {
  const messages = [
    { role: "system", content: "禁止词「毛泽东」" },
    { role: "assistant", content: null, toolCalls: [{ id: "call_1", name: "read_product" }] },
    { role: "tool", content: [{ type: "text", text: "命中「主席」" }], toolCallId: "call_1" },
  ];
  const repaired = sanitisePromptMessages(messages, 1);
  assert.equal(repaired[0]!.content, "禁止词「政治人物姓名」");
  assert.equal(repaired[1]!.content, null);
  assert.deepEqual((repaired[1] as { toolCalls: unknown }).toolCalls, [{ id: "call_1", name: "read_product" }]);
  assert.deepEqual(repaired[2]!.content, [{ type: "text", text: "命中「领导职务称谓」" }]);
  // 等级 0 原样返回，且返回新数组避免调用方被就地修改。
  assert.deepEqual(sanitisePromptMessages(messages, 0), messages);
  assert.notEqual(sanitisePromptMessages(messages, 0), messages);
});

test("输入审核拒绝时逐级修复 prompt 并重试，成功即返回", async () => {
  const seen: string[] = [];
  const policy = buildVbkCopyPolicyPrompt();
  const result = await attemptWithPromptRepair({
    label: "test.planning",
    buildMessages: (level) => sanitisePromptMessages([{ role: "system", content: `${policy}\n上一轮失败原因：命中「主席」` }], level),
    call: async (messages, level) => {
      seen.push(String(messages[0]!.content));
      if (level < 2) throw moderationError;
      return "ok";
    },
  });
  assert.equal(result, "ok");
  assert.equal(seen.length, 3);
  assert.match(seen[0]!, /「主席」/);
  assert.doesNotMatch(seen[1]!, /「主席」/);
  assert.ok(seen[1]!.includes(policy), "等级 1 只替换字面量");
  assert.ok(!seen[2]!.includes(policy), "等级 2 移除整段黑名单");
});

test("非输入审核错误不触发修复，直接抛出原始错误", async () => {
  let calls = 0;
  const timeout = Object.assign(new Error("request timed out"), { status: 408 });
  await assert.rejects(attemptWithPromptRepair({
    label: "test.timeout",
    buildMessages: () => [{ role: "user", content: "hi" }],
    call: async () => { calls += 1; throw timeout; },
  }), (error: unknown) => error === timeout);
  assert.equal(calls, 1);
});

test("修复等级用尽仍被审核拒绝时，抛出最后一次错误", async () => {
  let calls = 0;
  await assert.rejects(attemptWithPromptRepair({
    label: "test.exhausted",
    buildMessages: () => [{ role: "user", content: "hi" }],
    call: async () => { calls += 1; throw moderationError; },
  }), (error: unknown) => error === moderationError);
  // 三级改造后请求完全相同：只发一次，不重复发同一份必被拒的 prompt。
  assert.equal(calls, 1);
});
