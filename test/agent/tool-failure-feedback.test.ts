import assert from "node:assert/strict";
import test from "node:test";
import { formatToolFailureForModel } from "../../src/main/agent/core-tools.js";

test("工具失败文案回传模型并提示最多再自调用一次", () => {
  const text = formatToolFailureForModel("query_poi", "VBK POI 查询失败：HTTP 430");
  assert.match(text, /^工具失败：VBK POI 查询失败：HTTP 430/);
  assert.match(text, /工具：query_poi/);
  assert.match(text, /最多再试一次/);
  assert.match(text, /ask_user/);
});
