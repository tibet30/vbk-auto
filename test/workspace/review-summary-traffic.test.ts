import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import test from "node:test";

const source = readFileSync("src/renderer/app/views/workspace/review-summary-traffic.tsx", "utf8");

test("审查态展示母产品创建前的班次预检结论", () => {
  assert.match(source, /scheduleStatus === "available" \? "preflightVerified"/);
  assert.match(source, /前置班次已通过/);
  assert.match(source, /前置班次未通过/);
  assert.match(source, /前置查询待重试/);
  assert.match(source, /只有明确通过的方式才创建子产品/);
});

test("真实班期失败仍以异常状态展示，不会被审查态文案掩盖", () => {
  assert.match(source, /progress\?\.failureReason \? "failed"/);
  assert.match(source, /班期核验需处理/);
});
