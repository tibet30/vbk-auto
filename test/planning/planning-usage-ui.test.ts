import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { summarizeAiUsageMetric } from "../../src/renderer/app/views/workspace/planning-usage-format.js";
import type { ProductAiUsage } from "../../src/shared/contracts-ai-usage.js";

const read = (file: string) => readFileSync(path.resolve(process.cwd(), file), "utf8");
const usage = read("src/renderer/app/views/workspace/planning-usage.tsx");
const usageFormat = read("src/renderer/app/views/workspace/planning-usage-format.ts");
const tree = read("src/renderer/app/views/workspace/planning-tree.tsx");
const review = read("src/renderer/app/views/workspace/review.tsx");
const styles = read("src/renderer/app/views/workspace/planning-usage.module.less");

test("summarizeAiUsageMetric 在有费用时附带约 ¥", () => {
  const aiUsage: ProductAiUsage = {
    events: [],
    lifetime: {
      calls: 2,
      durationMs: 3000,
      inputTokens: 1200,
      outputTokens: 300,
      totalTokens: 1500,
      tokensIncomplete: false,
      estimatedCostCny: 0.12,
    },
    latestRun: {
      calls: 1,
      durationMs: 1000,
      inputTokens: 800,
      outputTokens: 200,
      totalTokens: 1000,
      tokensIncomplete: false,
      estimatedCostCny: 0.08,
      runId: "run-1",
    },
    byStage: [],
  };
  const label = summarizeAiUsageMetric(aiUsage);
  assert.match(label, /本产品 1\.5k/);
  assert.match(label, /上次 1k/);
  assert.match(label, /约 ¥0\.12/);
});

test("规划树接入 AI usage 指标与明细面板", () => {
  assert.match(tree, /aiUsage\?: ProductAiUsage/);
  assert.match(tree, /usePlanningUsage\(aiUsage\)/);
  assert.match(tree, /PlanningUsageToggle/);
  assert.match(tree, /PlanningUsagePanel/);
  assert.match(review, /aiUsage=\{product\.aiUsage\}/);
});

test("usage 文案覆盖本产品、上次、Token 未返回、约 ¥", () => {
  assert.match(usageFormat, /本产品/);
  assert.match(usageFormat, /上次/);
  assert.match(usageFormat, /Token 未返回/);
  assert.match(usageFormat, /约 ¥/);
  assert.match(usageFormat, /summarizeAiUsageMetric/);
  assert.match(usage, /summarizeAiUsageMetric/);
});

test("usage 样式保持紧凑单行，不做大卡片仪表盘", () => {
  assert.match(styles, /\.metric \{/);
  assert.match(styles, /font-size: 12px/);
  assert.match(styles, /text-overflow: ellipsis/);
  assert.doesNotMatch(styles, /min-height:\s*[5-9]\d{2}px/);
  assert.doesNotMatch(usage, /dashboard|仪表盘/);
});

test("usage 面板内容全部展开，不在面板内滚动", () => {
  assert.doesNotMatch(styles, /\.panel \{[^}]*max-height:/s);
  assert.doesNotMatch(styles, /\.panelBody \{[^}]*overflow:\s*auto/s);
});

test("usage 面板收起时整块消失，与生成规划下拉口径一致", () => {
  assert.match(styles, /\.panel \{[^}]*margin:\s*0 12px;/s);
  assert.match(usage, /onClose/);
  assert.match(usage, /收起 AI Token 消耗/);
  assert.match(usage, /ChevronDown/);
  assert.doesNotMatch(usage, /useState\(true\)/);
  assert.doesNotMatch(usage, /onToggleExpanded/);
  assert.match(tree, /onClose=\{\(\) => usage\.setOpen\(false\)\}/);
});

test("生成规划收起时 Token、行程树、采用提示同在 treeBody 内一并隐藏", () => {
  assert.match(tree, /\{!treeCollapsed \? \(/);
  assert.match(tree, /className=\{styles\.treeBody\}/);
  assert.match(tree, /PlanningUsagePanel/);
  assert.match(tree, /planning-stage-list/);
  assert.match(tree, /adoptionCard|行程尚未采用/);
  const bodyStart = tree.indexOf("styles.treeBody");
  const usageIdx = tree.indexOf("PlanningUsagePanel", bodyStart);
  const stageIdx = tree.indexOf("planning-stage-list", bodyStart);
  const adoptionIdx = tree.indexOf("itineraryAdoption", bodyStart);
  assert.ok(usageIdx > bodyStart && stageIdx > bodyStart && adoptionIdx > bodyStart);
  assert.ok(usageIdx < stageIdx && stageIdx < adoptionIdx);
});

test("usage 明细按列对齐：次数、耗时、入、出、费用", () => {
  assert.match(styles, /grid-template-columns:/);
  assert.match(styles, /\.num \{[^}]*text-align:\s*right/s);
  assert.match(styles, /font-variant-numeric:\s*tabular-nums/);
  assert.match(usage, />次数</);
  assert.match(usage, />耗时</);
  assert.match(usage, />入</);
  assert.match(usage, />出</);
  assert.match(usage, />费用</);
  assert.match(usage, /formatCost\(/);
  assert.match(usage, /UsageTableHeader/);
});
