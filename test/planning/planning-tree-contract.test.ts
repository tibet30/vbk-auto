import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";

const read = (file: string) => readFileSync(path.resolve(process.cwd(), file), "utf8");
const tree = read("src/renderer/app/views/workspace/planning-tree.tsx");
const styles = read("src/renderer/app/views/workspace/planning-tree.module.less");

test("stage rerun confirms invalidated data and uses the dedicated IPC", () => {
  assert.match(tree, /window\.confirm/);
  assert.match(tree, /产品 UUID、目的地、天数、形态、供应商编号和账号固定信息会保留/);
  assert.match(tree, /planning\.rerunMajorStage\(productId, stage\)/);
  assert.match(tree, /重做此阶段/);
});

test("planning tree expands all major stages by default and exposes accessible controls", () => {
  assert.match(tree, /const isCollapsed = collapsed\[stage\.id\] \?\? false/);
  assert.match(tree, /aria-expanded=\{!isCollapsed\}/);
  assert.match(tree, /tabIndex=\{0\}/);
  assert.match(styles, /:focus-visible/);
});

test("login block, AI failure and node status have distinct operator-facing text", () => {
  assert.match(tree, /登录恢复后可从此处继续，不消耗业务尝试次数/);
  assert.match(tree, /校验未通过，可查看错误后继续或重做阶段/);
  assert.match(tree, /被阻塞/);
  assert.match(tree, /未通过/);
});
