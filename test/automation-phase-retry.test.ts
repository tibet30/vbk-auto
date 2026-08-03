import test from "node:test";
import assert from "node:assert/strict";
import { preparePhaseRetry } from "../src/main/automation/phase-retry.js";

const previous = {
  id: "run-1",
  status: "failed" as const,
  currentPhase: "presentation",
  phases: [
    { phase: "basic", status: "completed" as const },
    { phase: "presentation", status: "failed" as const },
    { phase: "itinerary", status: "pending" as const },
  ],
  logs: [{ at: "2026-08-02T00:00:00.000Z", message: "失败", level: "error" as const }],
};

test("从失败阶段重试时保留之前的成功阶段并重置后续阶段", () => {
  const next = preparePhaseRetry(previous, ["basic", "presentation", "itinerary"], "presentation", "2026-08-02T01:00:00.000Z");
  assert.equal(next.id, previous.id);
  assert.equal(next.status, "running");
  assert.equal(next.currentPhase, "presentation");
  assert.deepEqual(next.phases.map((item) => item.status), ["completed", "pending", "pending"]);
  assert.match(next.logs.at(-1)?.message || "", /presentation/);
});

test("不能重试成功或未知阶段", () => {
  assert.throws(() => preparePhaseRetry(previous, ["basic", "presentation"], "basic"), /不是失败状态/);
  assert.throws(() => preparePhaseRetry(previous, ["basic", "presentation"], "package"), /未知阶段/);
});

test("只有失败的自动录入任务允许阶段重试", () => {
  assert.throws(() => preparePhaseRetry({ ...previous, status: "running" }, ["basic", "presentation"], "presentation"), /只有失败/);
});
