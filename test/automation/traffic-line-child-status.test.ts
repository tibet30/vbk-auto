import test from "node:test";
import assert from "node:assert/strict";
import { trafficLineChildStatus, trafficLineEndpointHint, trafficLineSkipLabel, latestTrafficLineEndpointPlan } from "../../src/renderer/app/helpers/traffic-line-child-status.js";

test("泸州历史跳过标记不能覆盖已通过的最终交通回读", () => {
  assert.equal(trafficLineChildStatus({
    verified: true, skipped: true, childProductId: "79236800",
    completedStages: ["clausesSaved", "activated", "finalReadback"],
  }, true), "completed");
});

test("未通过回读的不可售火车仍显示已跳过", () => {
  assert.equal(trafficLineChildStatus({ verified: false, skipped: true }, true), "skipped");
  assert.equal(trafficLineChildStatus({ verified: false, failedStage: "clausesSaved" }, true), "failed");
});

test("完成及不可售结果的提示不再显示待写入", () => {
  assert.match(trafficLineEndpointHint("completed", true), /已完成 VBK 回读/);
  assert.match(trafficLineEndpointHint("skipped", true), /本轮已跳过/);
  assert.match(trafficLineEndpointHint("pending", false), /待写入/);
});

test("泸州资源核验改站后展示实际执行站点而非旧准备站点", () => {
  const latest = { train: { arrival: { name: "泸州东" } } };
  const initial = { train: { arrival: { name: "泸州" } } };
  assert.deepEqual(latestTrafficLineEndpointPlan(latest, initial), latest);
  assert.deepEqual(latestTrafficLineEndpointPlan(undefined, initial), initial);
});


test("保存和有效化失败不显示为本班期已跳过", () => {
  assert.equal(trafficLineChildStatus({ verified: false, skipped: true, variant: "flightRoundTrip",
    failureReason: "当前产品未匹配玩法线路，请提交审核匹配线路" }, true), "failed");
  assert.match(trafficLineEndpointHint("failed", true), /仍需处理/);
  assert.equal(trafficLineChildStatus({ verified: false, skipped: true, variant: "trainRoundTrip",
    failureReason: "子产品资源校验后没有任何可用的多出发城市" }, true), "skipped");
});

test("带失败原因的子产品显示已跳过，端点提示写明原因", () => {
  const item = { verified: false, variant: "trainRoundTrip", failedStage: "resourcesSaved",
    failureReason: "产品没有可用于交通资源核验的销售班期，已保留交通子产品基础信息，跳过班期资源设置。" };
  assert.equal(trafficLineChildStatus(item, true), "skipped");
  assert.match(trafficLineEndpointHint("skipped", true, trafficLineSkipLabel(item)), /已跳过：本地未配置销售班期，请在价格库存班期补充后重试/);
  assert.equal(trafficLineSkipLabel({ verified: false, failureReason: "请求超时" }), "子产品录入失败，已跳过");
});
