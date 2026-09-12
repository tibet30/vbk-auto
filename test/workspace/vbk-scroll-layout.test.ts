import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (relativePath: string) => readFileSync(path.join(repoRoot, relativePath), "utf8");
const layoutStyles = read("src/renderer/app/views/workspace/layout.module.less");
const vbkStyles = read("src/renderer/app/views/workspace/vbk.module.less");

test("VBK progress panel owns vertical scrolling without clipping the footer", () => {
  const splitPanel = layoutStyles.slice(
    layoutStyles.indexOf(".stageSplit > .panel"),
    layoutStyles.indexOf("@media", layoutStyles.indexOf(".stageSplit > .panel")),
  );
  assert.doesNotMatch(splitPanel, /height:\s*100%/);
  assert.match(splitPanel, /min-height:\s*0/);

  const reviewSummary = vbkStyles.slice(vbkStyles.indexOf(".reviewSummary"), vbkStyles.indexOf(".productScroll"));
  assert.match(reviewSummary, /min-height:\s*0/);

  const productScroll = vbkStyles.slice(vbkStyles.indexOf(".productScroll"), vbkStyles.indexOf("Readiness hero"));
  assert.match(productScroll, /flex:\s*1 1 0/);
  assert.match(productScroll, /overflow-y:\s*auto/);
  assert.match(productScroll, /padding:[^;]*max\(var\(--pad\), 72px\)/);
  assert.match(productScroll, /overscroll-behavior:\s*contain/);
});
