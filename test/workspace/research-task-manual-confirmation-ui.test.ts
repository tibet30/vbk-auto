import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const openIssues = readFileSync("src/renderer/app/views/workspace/review-summary-open-issues.tsx", "utf8");
const reviewSummary = readFileSync("src/renderer/app/views/workspace/review-summary.tsx", "utf8");

test("待处理事项为 research task 提供清晰的手动确认入口", () => {
  assert.match(openIssues, /issue\.taskId\s*\?\s*"手动确认"\s*:\s*"处理"/);
  assert.match(reviewSummary, /填写已在 VBK 手工确认的结果/);
  assert.match(reviewSummary, /disabled=\{loading \|\| !verificationNote\.trim\(\)\}/);
  assert.match(reviewSummary, /确认已处理/);
});
