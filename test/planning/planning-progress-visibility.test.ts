/** 规划阶段进度与实时状态更新后的 UI 契约。 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { PLANNING_STAGES } from "../../src/shared/contracts-planning.js";
import {
  buildPlanningStageProgress,
  planningStageLabel,
  PLANNING_STAGE_LABELS,
} from "../../src/renderer/app/helpers/constants.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (rel: string) => readFileSync(path.join(repoRoot, rel), "utf8");
const reviewSrc = read("src/renderer/app/views/workspace/review.tsx");
const lessSrc = read("src/renderer/app/views/workspace/review.chat.module.less");
const derivedSrc = read("src/renderer/app/state/derived.ts");

test("实时 running 状态仍按共享阶段顺序显示已完成、进行中、待开始", () => {
  const progress = buildPlanningStageProgress(
    { currentStage: "itinerary", completedStages: ["skeleton", "basicInfo"] },
    PLANNING_STAGES,
  );
  assert.deepEqual(progress.map((item) => item.stage), [...PLANNING_STAGES]);
  assert.deepEqual(progress.filter((item) => item.state === "completed").map((item) => item.stage), ["skeleton", "basicInfo"]);
  assert.equal(progress.find((item) => item.state === "current")?.stage, "itinerary");
  for (const item of progress) {
    assert.equal(item.label, PLANNING_STAGE_LABELS[item.stage]);
    assert.notEqual(item.label, item.stage);
  }
});

test("终态 failed 与 needs_user 仍保留恢复 UI，完整 completed 才隐藏进度", () => {
  assert.match(derivedSrc, /if \(status === "completed" && allStagesCompleted\) return null/);
  assert.match(derivedSrc, /else if \(status === "failed"\) headline = "方案规划失败，需要重试。"/);
  assert.match(derivedSrc, /else if \(status === "needs_user"\) headline = "方案规划已暂停，等待补充缺失模块。"/);
  assert.match(reviewSrc, /data-testid="planning-resume-button"/);
  assert.match(reviewSrc, /重试规划/);
  assert.match(reviewSrc, /继续规划/);
  assert.match(reviewSrc, /已接受：/);
  assert.match(reviewSrc, /缺失：/);
});

test("阶段进度视图及三档样式维持不变", () => {
  assert.match(reviewSrc, /当前阶段：/);
  assert.match(reviewSrc, /planningRecovery\.currentStageLabel/);
  assert.match(reviewSrc, /data-state=\{entry\.state\}/);
  for (const state of ["completed", "current", "pending"]) {
    assert.match(lessSrc, new RegExp(`recoveryStageItem\\[data-state=['"]${state}['"]\\]`));
  }
});

test("阶段标签总是中文，避免 event state 直接泄漏裸 stage id", () => {
  for (const stage of PLANNING_STAGES) {
    assert.match(planningStageLabel(stage), /[一-鿿]/);
  }
  assert.equal(planningStageLabel(undefined), "当前阶段");
});
