/**
 * VBK 单阶段「重新执行」图标状态回归契约。
 *
 * IPC 发起重跑后会立即返回，但后台阶段还在执行；图标必须继续以持久化
 * automation.currentPhase 为准旋转，不能在请求返回后回到静态刷新图标。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (relativePath: string) => readFileSync(path.join(repoRoot, relativePath), "utf8");
const view = read("src/renderer/app/views/workspace/vbk.tsx");
const styles = read("src/renderer/app/views/workspace/vbk.module.less");

test("重新执行图标在持久化阶段仍运行时保持旋转", () => {
  assert.match(
    view,
    /retryingPhase === phaseKey\s*\|\|\s*\(product\.automation\?\.status === "running" && product\.automation\.currentPhase === phaseKey\)/,
  );
  assert.match(view, /<LoaderCircle size=\{12\} className=\{styles\.stageActionSpinner\} \/>/);
  assert.match(styles, /\.stageActionSpinner\s*\{\s*animation:\s*spin 0\.8s linear infinite;/);
});

test("减少动态效果时停止重新执行图标的循环动画", () => {
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.stageActionSpinner\s*\{\s*animation:\s*none;/);
});
