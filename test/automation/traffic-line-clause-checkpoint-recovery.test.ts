import test from "node:test";
import assert from "node:assert/strict";
import { trafficClauseMaterializationCanResume, trafficSegmentSubmitNeedsRecovery } from "../../src/main/automation/ctrip/traffic-line/child-failure.js";
import type { TrafficLineChildProgress } from "../../src/shared/contracts-traffic-line.js";

function checkpoint(variant: TrafficLineChildProgress["variant"]): TrafficLineChildProgress {
  return { variant, lineDescription: "交通套餐", childProductId: "12345", verified: false,
    completedStages: ["resourcesSaved", "itinerarySaved"], failedStage: "clausesSaved",
    validationSubmittedAt: "2026-10-08T04:10:32.000Z",
    failureReason: `子产品资源回读尚未生成${variant === "flightRoundTrip" ? "飞机" : "火车"}去返程条款，未保存条款，可安全重试。` };
}

test("飞机与火车条款迟到使用已保存资源恢复，激活阶段同样适用", () => {
  for (const variant of ["flightRoundTrip", "trainRoundTrip"] as const) {
    const progress = checkpoint(variant);
    assert.equal(trafficClauseMaterializationCanResume(progress), true);
    assert.equal(trafficClauseMaterializationCanResume({ ...progress, failedStage: "activated" }), true);
    assert.equal(trafficSegmentSubmitNeedsRecovery(progress), false);
  }
});

test("资源未完成、提交未知与其它失败不得进入条款定向恢复", () => {
  const progress = checkpoint("flightRoundTrip");
  for (const patch of [{ completedStages: ["itinerarySaved"] }, { validationSubmittedAt: undefined },
    { childProductId: undefined }, { failedStage: "resourcesSaved" }, { failureReason: "登录失效" },
    { failureReason: "子产品资源提交仍在 VBK 异步核验" }] as Partial<TrafficLineChildProgress>[]) {
    assert.equal(trafficClauseMaterializationCanResume({ ...progress, ...patch }), false);
  }
});
