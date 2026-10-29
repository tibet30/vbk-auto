import test from "node:test";
import assert from "node:assert/strict";
import { durationSyncFailureReason, durationSyncNote } from "../../src/shared/traffic-duration-sync.js";
import { trafficChildOutcomes } from "../../src/shared/traffic-child-outcome.js";
import { trafficSkipReason } from "../../src/shared/traffic-skip-reason.js";
import { trafficLineSkipLabel } from "../../src/renderer/app/helpers/traffic-line-child-status.js";
import { trafficSummaryMessage } from "../../src/main/application/traffic-summary-message.js";

test("同步天数失败原因写明子产品仍为旧 N 天，且仍按子产品录入失败跳过", () => {
  const reason = durationSyncFailureReason("VBK 行程保存失败：HTTP 500", 2);
  assert.equal(reason, "子产品仍为旧 2 天，未与母产品同步：VBK 行程保存失败：HTTP 500");
  assert.equal(durationSyncFailureReason(reason, 2), reason, "不重复前置");
  assert.equal(trafficSkipReason(reason, "trainRoundTrip"), "child_failed");
  assert.equal(durationSyncNote(reason), "子产品仍为旧 2 天，未与母产品同步");
  assert.equal(durationSyncNote(durationSyncFailureReason("x", undefined)), "子产品仍为旧天数，未与母产品同步");
  assert.equal(durationSyncNote(durationSyncFailureReason("x", 2, false)), "子产品可能仍为旧天数，未与母产品同步");
  assert.equal(durationSyncNote("浏览器请求超时"), undefined);
  assert.equal(durationSyncFailureReason("当前无可售资源", 2), "当前无可售资源", "前置提示不能改变平台无资源的分类");
  const inventory = durationSyncFailureReason("产品没有可用于交通资源核验的销售班期，跳过班期资源设置。", 2);
  assert.equal(trafficSkipReason(inventory), "local_inventory_missing");
  assert.equal(durationSyncNote(inventory), "子产品仍为旧 2 天，未与母产品同步");
});

test("跳过标签与结案汇总都带出旧天数提示", () => {
  const reason = durationSyncFailureReason("激活失败", 3);
  const child = { variant: "trainRoundTrip", lineDescription: "火车往返", verified: false, skipped: true,
    skipReason: "child_failed", completedStages: ["childCreated"], failedStage: "resourcesSaved", failureReason: reason } as const;
  assert.equal(trafficLineSkipLabel(child as any), "子产品录入失败，已跳过（子产品仍为旧 3 天，未与母产品同步）");
  const outcomes = trafficChildOutcomes({ enabled: true, variants: ["trainRoundTrip"] } as any, { children: [child] } as any);
  assert.deepEqual(outcomes.skipped, [{ variant: "trainRoundTrip", reason: "child_failed", note: "子产品仍为旧 3 天，未与母产品同步" }]);
  const plain = trafficChildOutcomes({ enabled: true, variants: ["trainRoundTrip"] } as any,
    { children: [{ ...child, failureReason: "浏览器请求超时" }] } as any);
  assert.deepEqual(plain.skipped, [{ variant: "trainRoundTrip", reason: "child_failed" }]);
});

test("母产品结案汇总写明子产品仍为旧天数", () => {
  const product = { product: { operations: { trafficLine: { enabled: true, variants: ["trainRoundTrip"] } } },
    automation: { trafficLine: { children: [{ variant: "trainRoundTrip", lineDescription: "火车往返", verified: false, skipped: true,
      skipReason: "child_failed", completedStages: [], failureReason: durationSyncFailureReason("激活失败", 3) }] } } };
  assert.equal(trafficSummaryMessage(product as any),
    "母产品草稿已通过核验；已跳过 1 个子产品：火车往返（子产品录入失败，已跳过；子产品仍为旧 3 天，未与母产品同步）");
});
