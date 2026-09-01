import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createPlanningPlanV2 } from "../../src/main/planning/three-stage-orchestrator.js";
import { prepareExplicitPlanningResume } from "../../src/main/planning/planning-explicit-resume.js";

test("用户显式恢复时只重置耗尽的失败节点，保留已完成节点和原错误", () => {
  const plan = createPlanningPlanV2("2026-09-01T00:00:00.000Z");
  plan.status = "needs_user";
  plan.currentNode = "itineraryDraft";
  plan.nodes = plan.nodes.map((node) => node.id === "skeleton"
    ? { ...node, status: "completed", attempts: 1, completedAt: "2026-09-01T00:01:00.000Z" }
    : node.id === "itineraryDraft"
      ? { ...node, status: "failed", attempts: 3, error: "第 6 天缺少标题、描述或有效活动节点" }
      : node);

  const resumed = prepareExplicitPlanningResume(plan);
  const itinerary = resumed.nodes.find((node) => node.id === "itineraryDraft")!;

  assert.equal(resumed.status, "pending");
  assert.equal(itinerary.status, "pending");
  assert.equal(itinerary.attempts, 0);
  assert.equal(itinerary.error, "第 6 天缺少标题、描述或有效活动节点");
  assert.equal(resumed.nodes.find((node) => node.id === "skeleton")?.status, "completed");
});

test("未耗尽或非失败节点在显式恢复时保持原样", () => {
  const plan = createPlanningPlanV2();
  plan.status = "needs_user";
  plan.currentNode = "itineraryDraft";
  plan.nodes = plan.nodes.map((node) => node.id === "itineraryDraft"
    ? { ...node, status: "failed", attempts: 2, error: "临时错误" }
    : node);

  assert.equal(prepareExplicitPlanningResume(plan), plan);
});

test("后台中断恢复沿用远端规划，不走 foundation 重置", () => {
  const source = readFileSync("src/main/ipc/planning-v2-ipc.ts", "utf8");
  const start = source.indexOf("const resumePlanningUnderLock");
  const end = source.indexOf("const resumePlanning =", start);
  const resumeFlow = source.slice(start, end);

  assert.match(resumeFlow, /runBody\(localProductId, remote\.planning\)/);
  assert.doesNotMatch(resumeFlow, /createPlanningPlanV2|resetProductForPlanningStage/);
});
