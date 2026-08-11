import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const source = fs.readFileSync("src/renderer/app/views/workspace/review-summary-open-issues.tsx", "utf8");

test("待处理事项刷新按钮有 busy 文案并阻止点击冒泡", () => {
  assert.match(source, /RefreshCw/);
  assert.match(source, /LoaderCircle/);
  assert.match(source, /刷新中…/);
  assert.match(source, /event\.stopPropagation\(\)/);
  assert.match(source, /disabled=\{refreshing\}/);
  assert.match(source, /aria-busy=\{refreshing\}/);
});

test("待处理事项标题行避免 button 内嵌 button", () => {
  assert.match(source, /<div className=\{styles\.head\}>/);
  assert.match(source, /className=\{styles\.headToggle\}/);
  assert.match(source, /className=\{styles\.refreshBtn\}/);
  assert.doesNotMatch(source, /<button[\s\S]*className=\{styles\.head\}[\s\S]*<button/);
});
