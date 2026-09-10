import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import test from "node:test";

const source = readFileSync("src/renderer/app/views/workspace/review-summary-traffic.tsx", "utf8");

test("审查态只展示端点核验，班期资源留到子产品阶段", () => {
  assert.doesNotMatch(source, /scheduleChecks/);
  assert.match(source, /端点已确认，待核验班期资源/);
  assert.match(source, /创建子产品后才执行 VBK 正式班期资源校验/);
});

test("真实班期失败仍以异常状态展示，不会被审查态文案掩盖", () => {
  assert.match(source, /progress\?\.failureReason \? "failed"/);
  assert.match(source, /班期核验需处理/);
});
