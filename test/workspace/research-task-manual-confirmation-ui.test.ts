import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const openIssues = readFileSync("src/renderer/app/views/workspace/review-summary-open-issues.tsx", "utf8");
const reviewSummary = readFileSync("src/renderer/app/views/workspace/review-summary.tsx", "utf8");
const reviewSummaryComponent = readFileSync("src/renderer/app/views/workspace/review-summary/component.tsx", "utf8");
const reviewSummaryActiveTaskFooter = readFileSync("src/renderer/app/views/workspace/review-summary/active-task-footer.tsx", "utf8");
const reviewSummaryGeneratingSkeleton = readFileSync("src/renderer/app/views/workspace/review-summary/generating-skeleton.tsx", "utf8");
const reviewSummaryFull = [
  reviewSummary,
  reviewSummaryComponent,
  reviewSummaryActiveTaskFooter,
  reviewSummaryGeneratingSkeleton,
].join("\n");

test("待处理事项为 research task 提供清晰的手动确认入口", () => {
  assert.match(openIssues, /issue\.taskId\s*\?\s*"手动确认"\s*:\s*"处理"/);
  assert.match(reviewSummaryFull, /填写已在 VBK 手工确认的结果/);
  assert.match(reviewSummaryFull, /disabled=\{loading \|\| !verificationNote\.trim\(\)\}/);
  assert.match(reviewSummaryFull, /确认已处理/);
});
