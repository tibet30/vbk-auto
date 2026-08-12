import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("行程提交为 VBK AI 审核保留最长两分钟跳转窗口", async () => {
  const source = await readFile(
    new URL("../../src/main/automation/ctrip/itinerary/main.ts", import.meta.url),
    "utf8",
  );
  const submit = source.slice(source.indexOf("const submitResult = await saveThenAdvance"));
  assert.match(submit, /nextButtonLabel: "提交审核并下一步"/);
  assert.match(submit, /advanceTimeoutMs: 120_000/);
});
