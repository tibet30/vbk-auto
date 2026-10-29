import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import test from "node:test";
import { trafficLineSkipLabel, trafficLineStatusTone, trafficReviewResourceState } from "../../src/renderer/app/helpers/traffic-line-child-status.js";

const source = readFileSync("src/renderer/app/views/workspace/review-summary-traffic.tsx", "utf8");

test("审查态只展示端点核验，班期资源留到子产品阶段", () => {
  assert.doesNotMatch(source, /scheduleChecks/);
  assert.match(source, /端点已确认，待核验班期资源/);
  assert.match(source, /创建子产品后才执行 VBK 正式班期资源校验/);
});

test("真实班期失败仍以异常状态展示，不会被审查态文案掩盖", () => {
  assert.match(source, /trafficReviewResourceState\(progress, checking, Boolean\(trafficProgress\?\.failureReason\)\)/);
  assert.match(source, /班期核验需处理/);
  assert.equal(trafficReviewResourceState({ verified: false, failureReason: "请求超时" }, false, false), "failed");
  assert.equal(trafficReviewResourceState(null, false, true), "failed");
});

test("缺销售班期的已跳过子产品显示已跳过与原因，玩法线路审核仍显示需处理", () => {
  const inventory = { variant: "trainRoundTrip", verified: false, skipped: true, skipReason: "local_inventory_missing",
    failedStage: "resourcesSaved", failureReason: "产品没有可用于交通资源核验的销售班期，已保留交通子产品基础信息，跳过班期资源设置。" };
  assert.equal(trafficReviewResourceState(inventory, false, false), "skipped");
  assert.equal(trafficLineSkipLabel(inventory), "本地未配置销售班期，请在价格库存班期补充后重试");
  assert.match(source, /已跳过：\$\{item\.skipLabel\}/);
  const routeReview = { variant: "flightRoundTrip", verified: false, skipped: true, failedStage: "activated",
    failureReason: "当前产品未匹配玩法线路，请去行程描述/资源配置页面提交审核匹配线路" };
  assert.equal(trafficReviewResourceState(routeReview, false, false), "failed");
});

test("已跳过显示为警示黄，不与失败共用红色", () => {
  assert.equal(trafficLineStatusTone("skipped"), "skipped");
  assert.equal(trafficLineStatusTone("failed"), "failed");
  assert.equal(trafficLineStatusTone("needs_user"), "failed");
  const reviewLess = readFileSync("src/renderer/app/views/workspace/review-summary-traffic.module.less", "utf8");
  const skippedRule = reviewLess.match(/\.itemState\[data-state="skipped"\]\s*\{([^}]*)\}/)?.[1] ?? "";
  assert.match(skippedRule, /var\(--warning\)/);
  assert.doesNotMatch(skippedRule, /--destructive/);
  const progressLess = readFileSync("src/renderer/app/helpers/traffic-line-progress.module.less", "utf8");
  assert.match(progressLess, /\.card\[data-state='skipped'\]\s*\{[^}]*var\(--warning\)/);
  assert.match(progressLess, /\.state\[data-state='skipped'\]\s*\{[^}]*var\(--warning\)/);
});
