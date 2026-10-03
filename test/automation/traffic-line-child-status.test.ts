import test from "node:test";
import assert from "node:assert/strict";
import { trafficLineChildStatus, trafficLineEndpointHint, latestTrafficLineEndpointPlan } from "../../src/renderer/app/helpers/traffic-line-child-status.js";

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
