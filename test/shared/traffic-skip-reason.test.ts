import test from "node:test";
import assert from "node:assert/strict";
import { TRAFFIC_SKIP_LABELS, trafficSkipReason } from "../../src/shared/traffic-skip-reason.js";
import { blockingTrafficVariants, incompleteTrafficVariants } from "../../src/shared/traffic-resource-status.js";

test("子产品跳过原因区分本地缺班期、平台无资源与录入失败", () => {
  assert.equal(trafficSkipReason("产品没有可用于交通资源核验的销售班期，已保留交通子产品基础信息，跳过班期资源设置。"), "local_inventory_missing");
  assert.equal(trafficSkipReason("当前无可售资源"), "platform_unavailable");
  assert.equal(trafficSkipReason("出发城市为空,不能打包", "trainRoundTrip"), "platform_unavailable");
  assert.equal(trafficSkipReason("浏览器请求超时"), "child_failed");
  assert.deepEqual(TRAFFIC_SKIP_LABELS, {
    platform_unavailable: "平台当前无可售交通资源",
    local_inventory_missing: "本地未配置销售班期，请在价格库存班期补充后重试",
    child_failed: "子产品录入失败，已跳过",
  });
});

test("缺销售班期的已跳过子产品仍可重试，但不阻塞母产品完成", () => {
  const config = { enabled: true, variants: ["trainRoundTrip"] } as const;
  const progress = { children: [{ variant: "trainRoundTrip", lineDescription: "火车往返", verified: false, skipped: true,
    skipReason: "local_inventory_missing", completedStages: ["childCreated"], failedStage: "resourcesSaved",
    failureReason: "产品没有可用于交通资源核验的销售班期，已保留交通子产品基础信息，跳过班期资源设置。" }] } as any;
  assert.deepEqual(incompleteTrafficVariants(config as any, progress), ["trainRoundTrip"]);
  assert.deepEqual(blockingTrafficVariants(config as any, progress), []);
});
