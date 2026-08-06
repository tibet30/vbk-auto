import { test } from "node:test";
import assert from "node:assert/strict";
import { readCtripSource, readAutomationSource } from "./basic-info-fixes.shared.js";

test("shared: readCtripSource 返回非空字符串", async () => {
  const source = await readCtripSource();
  assert.ok(source.includes("fillAndSaveBasicInfo"), "应拼接出 fillAndSaveBasicInfo 标记");
});

test("shared: readAutomationSource 返回非空字符串", async () => {
  const source = await readAutomationSource();
  assert.ok(source.includes("DraftAutomation") || source.includes("AutomationRun"), "应包含 automation 主入口/类型");
});
