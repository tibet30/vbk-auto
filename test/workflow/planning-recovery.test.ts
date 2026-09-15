/**
 * planningRecovery 纯函数行为测试。
 *
 * derived.ts 里的恢复条必须先有可单测的决策表，再考虑继续拆 hook。
 * 本文件不渲染 React，只锁定「规划状态 → 恢复条」的契约。
 */

import assert from "node:assert/strict";
import test from "node:test";
import { PLANNING_STAGES, type PlanningGenerationState } from "../../src/shared/contracts-planning.js";
import { buildPlanningRecovery } from "../../src/renderer/app/state/planning-recovery.js";

function state(overrides: Partial<PlanningGenerationState> = {}): PlanningGenerationState {
  return {
    localProductId: "p-1",
    currentStage: "itinerary",
    completedStages: ["skeleton", "basicInfo"],
    stages: [
      {
        stage: "basicInfo",
        accepted: [{ module: "basicInfo", status: "accepted", updatedAt: "t" }],
        rejected: [],
        attempts: 1,
        updatedAt: "t",
      },
      {
        stage: "itinerary",
        accepted: [],
        rejected: [{ module: "itinerary", status: "missing", updatedAt: "t" }],
        attempts: 1,
        updatedAt: "t",
      },
    ],
    status: "running",
    resumeAt: "itinerary",
    ...overrides,
  };
}

test("没有规划状态时不展示恢复条", () => {
  assert.equal(buildPlanningRecovery(null), null);
});

test("七个阶段都完成后，completed 不再展示恢复条", () => {
  const recovery = buildPlanningRecovery(state({
    status: "completed",
    currentStage: "validation",
    completedStages: [...PLANNING_STAGES],
    stages: PLANNING_STAGES.map((stage) => ({
      stage,
      accepted: [{ module: "basicInfo", status: "accepted" as const, updatedAt: "t" }],
      rejected: [],
      attempts: 1,
      updatedAt: "t",
    })),
  }));
  assert.equal(recovery, null);
});

test("running 展示进行中标题、阶段进度和已接受 / 缺失模块", () => {
  const recovery = buildPlanningRecovery(state());
  assert.ok(recovery);
  assert.equal(recovery.status, "running");
  assert.equal(recovery.headline, "方案规划进行中…");
  assert.deepEqual(recovery.accepted, ["basicInfo"]);
  assert.deepEqual(recovery.missing, ["itinerary"]);
  assert.equal(recovery.allStagesCompleted, false);
  assert.equal(recovery.currentStage, "itinerary");
  assert.match(recovery.currentStageLabel, /行程/);
  assert.equal(recovery.stageProgress?.length, PLANNING_STAGES.length);
  assert.equal(recovery.stageProgress?.find((item) => item.stage === "itinerary")?.state, "current");
  assert.match(recovery.hint, /分阶段生成/);
});

test("failed / needs_user / pending / 部分 completed 给出对应提示", () => {
  assert.equal(buildPlanningRecovery(state({ status: "failed" }))?.headline, "方案规划失败，需要重试。");
  assert.match(buildPlanningRecovery(state({ status: "failed" }))?.hint ?? "", /API Key/);
  assert.equal(buildPlanningRecovery(state({ status: "needs_user" }))?.headline, "方案规划已暂停，等待补充缺失模块。");
  assert.match(buildPlanningRecovery(state({ status: "needs_user" }))?.hint ?? "", /继续规划/);
  assert.equal(buildPlanningRecovery(state({ status: "pending" }))?.headline, "方案规划即将开始…");
  const partial = buildPlanningRecovery(state({
    status: "completed",
    completedStages: ["skeleton", "basicInfo"],
  }));
  assert.equal(partial?.headline, "方案已生成部分结果，等待继续规划。");
  assert.equal(partial?.allStagesCompleted, false);
  assert.ok(partial?.stageProgress);
});
