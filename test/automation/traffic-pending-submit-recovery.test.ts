import assert from "node:assert/strict";
import test from "node:test";
import { submitWithOnePendingRecovery } from "../../src/main/automation/ctrip/traffic-line/pending-submit-recovery.js";
import type { TrafficLineChildProgress } from "../../src/shared/contracts-traffic-line.js";
const now = new Date("2026-10-08T00:20:00Z");
const progress = { variant: "flightRoundTrip", completedStages: ["childCreated"], childProductId: "child", verified: false, validationScheduleCount: 3, validationSubmittedAt: "2026-10-08T00:00:00Z" } as TrafficLineChildProgress;
const pending = new Error("子产品资源提交仍在 VBK 异步核验（已只读查询）；未重复提交");
test("确认超过10分钟持续pending后，同一任务仅重提一次并记录恢复提交", async () => {
  const calls: boolean[] = [];
  const current = structuredClone(progress);
  await submitWithOnePendingRecovery({ now, progress: () => current, readState: async () => ({ status: "pending" }), submit: async retry => {
    calls.push(retry);
    if (!retry) throw pending;
    current.validationRecoveryResubmittedAt = now.toISOString();
  } });
  assert.deepEqual(calls, [false, true]);
  await assert.rejects(() => submitWithOnePendingRecovery({ now, progress: () => current, readState: async () => ({ status: "pending" }), submit: async retry => { calls.push(retry); throw pending; } }), /异步核验/);
  assert.deepEqual(calls, [false, true, false]);
});
test("刚提交、明确失败、未知错误或第二次仍超时不循环重提", async () => {
  for (const [current, state, error] of [[{ ...progress, validationSubmittedAt: now.toISOString() }, "pending", pending], [progress, "failed", pending], [progress, "pending", new Error("网络错误")]] as const) {
    let calls = 0;
    await assert.rejects(() => submitWithOnePendingRecovery({ now, progress: () => current as TrafficLineChildProgress, readState: async () => ({ status: state }), submit: async () => { calls++; throw error; } }));
    assert.equal(calls, 1);
  }
  let calls = 0;
  await assert.rejects(() => submitWithOnePendingRecovery({ now, progress: () => progress, readState: async () => ({ status: "pending" }), submit: async () => { calls++; throw pending; } }));
  assert.equal(calls, 2);
});

test("处理中重载保留提交证据，没有失败文案也必须先回读", async () => {
  const { trafficSegmentSubmitNeedsRecovery } = await import("../../src/main/automation/ctrip/traffic-line/child-failure.js");
  assert.equal(trafficSegmentSubmitNeedsRecovery(progress), true);
  assert.equal(trafficSegmentSubmitNeedsRecovery({ ...progress, validationSubmittedAt: undefined }), false);
  assert.equal(trafficSegmentSubmitNeedsRecovery({ ...progress, failureReason: "平台明确无票" }), false);
});
