import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const read = (file: string) => fs.readFileSync(file, "utf8");
const dialog = read("src/renderer/app/views/shell/UpdateDialog.tsx");
const dialogStyles = read("src/renderer/app/views/shell/UpdateDialog.module.less");
const summary = dialog.slice(dialog.indexOf("<summary"), dialog.indexOf("</summary>"));

test("诊断信息的复制入口挂在折叠行上，折叠时也能复制", () => {
  assert.ok(summary.includes("copyDiagnostics"), "复制按钮应位于 <summary> 内");
  // 点复制不应顺带展开或收起折叠区。
  assert.match(summary, /event\.preventDefault\(\)/);
  assert.match(summary, /event\.stopPropagation\(\)/);
});

test("复制成功与失败都有可见反馈，且到点回到常态", () => {
  assert.match(dialog, /const COPY_LABELS = \{ idle: "复制", done: "已复制", failed: "复制失败" \} as const;/);
  assert.match(dialog, /await copyText\(diagnosticText\(state\)\)/);
  assert.match(dialog, /setCopyState\(ok \? "done" : "failed"\)/);
  assert.match(dialog, /window\.setTimeout\(\(\) => setCopyState\("idle"\), COPY_FEEDBACK_MS\)/);
});

test("复制入口从弹窗主体里挪走后，不再留孤立的按钮行", () => {
  assert.doesNotMatch(dialog, /detailsActions/);
  assert.doesNotMatch(dialogStyles, /detailsActions/);
});

test("折叠行用底色表达焦点，避免整行被套成输入框观感", () => {
  assert.match(dialogStyles, /\.details summary:focus-visible \{[^}]*box-shadow:\s*none/);
  assert.match(dialogStyles, /\.details\[open\] \.chevron/);
});
