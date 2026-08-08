/**
 * 用户报告「控制台看不到任何日志」时，assistantReply 至少要把当前等待
 * 阶段暴露出来，避免 UI 长时间停在同一文本上找不到下一步动作。
 *
 * 本测试锁住 replies.ts composeAssistantReply 在 needs_user 状态下
 * 的可观测信息：当前 stage / DevTools 日志提示。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { composeAssistantReply } from "../../src/main/planning/replies.js";
import type { PlanningGenerationState, ModuleOutcome } from "../../src/shared/contracts-planning.js";

function makeState(overrides: Partial<PlanningGenerationState> = {}): PlanningGenerationState {
  return {
    projectId: "p",
    currentStage: "itinerary",
    completedStages: ["skeleton"],
    stages: [],
    status: "needs_user",
    resumeAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

test("needs_user 且当前 stage 已知时，reply 必须包含当前等待阶段与 DevTools 提示", () => {
  const state = makeState({ currentStage: "itinerary", status: "needs_user" });
  const accepted: ModuleOutcome[] = [{ module: "skeleton", status: "accepted" }];
  const missing: ModuleOutcome[] = [
    { module: "presentation", status: "missing", reason: "validation: 必需模块未落地" },
    { module: "itinerary", status: "missing", reason: "validation: 必需模块未落地" },
  ];
  const reply = composeAssistantReply(state, accepted, missing);
  assert.ok(reply.includes("当前等待阶段：itinerary"), `reply 必须指出当前等待阶段，实际：${reply}`);
  assert.ok(reply.includes("DevTools"), `reply 必须提示 DevTools 日志路径，实际：${reply}`);
  assert.ok(!reply.includes("方案规划完成"), `needs_user 不能声明完成，实际：${reply}`);
});

test("needs_user 且有 lastError 时优先拼出 stage+lastError 信息", () => {
  const state = makeState({
    currentStage: "presentation",
    status: "needs_user",
    stages: [{
      stage: "presentation",
      accepted: [],
      rejected: [],
      attempts: 2,
      lastError: { stage: "presentation", attempt: 2, code: "missing_module", message: "presentation 阶段未产出 accepted 模块" },
      updatedAt: "2026-01-01T00:00:00.000Z",
    }],
  });
  const reply = composeAssistantReply(state, [], []);
  assert.ok(reply.includes("最近失败"), `reply 必须带最近失败提示，实际：${reply}`);
  assert.ok(reply.includes("presentation"), `reply 必须包含失败阶段名，实际：${reply}`);
});

test("completed 状态必须显示「完成」，绝不显示「未完成」", () => {
  const state = makeState({ status: "completed" });
  const accepted: ModuleOutcome[] = [
    { module: "skeleton", status: "accepted" },
    { module: "itinerary", status: "accepted" },
  ];
  const reply = composeAssistantReply(state, accepted, []);
  assert.ok(reply.includes("完成"), `completed 应当含「完成」字样，实际：${reply}`);
  assert.ok(!reply.includes("未完成"), `completed 不能含「未完成」，实际：${reply}`);
});
