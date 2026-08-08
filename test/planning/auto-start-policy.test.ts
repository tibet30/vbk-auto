/**
 * auto-start policy 纯函数测试。
 *
 * 覆盖核心 race：reopen 一个持久化 failed 的项目时，derived.ts 的 auto-start effect
 * 必须在 planning.state(projectId) 完成前空跑。这里把决策函数抽到
 * auto-start-policy.ts 后做白盒单测。
 *
 * 重要：本文件不动 derived.ts，也不依赖 jsdom / RTL；只针对 shouldAutoStartPlanning
 * 的输入/输出。derived.ts 的 useEffect 行为由同目录下的 source-contract 测试约束。
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  shouldAutoStartPlanning,
  type AutoStartInputs,
} from "../../src/renderer/app/state/auto-start-policy.js";
import type {
  PlanningGenerationState,
} from "../../src/shared/contracts-planning.js";

const PROJECT_ID = "cf4af000-0000-0000-0000-000000000001";
const OTHER_PROJECT_ID = "cf4af000-0000-0000-0000-000000000002";

function baseInputs(overrides: Partial<AutoStartInputs> = {}): AutoStartInputs {
  return {
    hasProject: true,
    projectId: PROJECT_ID,
    hasUserMessages: false,
    hasItinerary: false,
    hasAiKey: true,
    planningStateLoadedProjectId: null,
    planningState: null,
    autoStartUsed: null,
    ...overrides,
  };
}

function makeState(overrides: Partial<PlanningGenerationState> = {}): PlanningGenerationState {
  return {
    projectId: PROJECT_ID,
    currentStage: "skeleton",
    completedStages: [],
    stages: [],
    status: "running",
    resumeAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

test("Gate 1: persisted failed state → zero planning.start", () => {
  // 场景：用户重新打开一个已经被持久化为 failed 的项目；planning.state 已返回。
  // 期望：auto-start 永不触发，由用户手动 planningResume。
  const failedState = makeState({ status: "failed" });
  const result = shouldAutoStartPlanning(baseInputs({
    planningState: failedState,
    planningStateLoadedProjectId: PROJECT_ID,
  }));
  assert.equal(result, false, "失败状态项目绝不能自动起跑");
});

test("Gate 1b: persisted needs_user state → zero planning.start", () => {
  const needsUserState = makeState({ status: "needs_user" });
  const result = shouldAutoStartPlanning(baseInputs({
    planningState: needsUserState,
    planningStateLoadedProjectId: PROJECT_ID,
  }));
  assert.equal(result, false, "needs_user 项目绝不能自动起跑");
});

test("Gate 1c: persisted running / completed state → zero planning.start", () => {
  for (const status of ["running", "completed", "pending"] as const) {
    const result = shouldAutoStartPlanning(baseInputs({
      planningState: makeState({ status }),
      planningStateLoadedProjectId: PROJECT_ID,
    }));
    assert.equal(result, false, `${status} 状态项目绝不能自动起跑`);
  }
});

test("Gate 2: undefined state（真·新项目）→ 一次 auto-start", () => {
  // 场景：planning.state 返回 undefined（DB 里没有该 projectId 的生成状态）；
  // sentinel 已标记为当前 projectId。期望：允许一次起跑。
  const result = shouldAutoStartPlanning(baseInputs({
    planningState: null,
    planningStateLoadedProjectId: PROJECT_ID,
    autoStartUsed: null,
  }));
  assert.equal(result, true, "新项目 lookup 返回 undefined 后应允许一次 auto-start");
});

test("Gate 2b: 同项目已经 autoStartUsed → 拒绝第二次", () => {
  const result = shouldAutoStartPlanning(baseInputs({
    planningState: null,
    planningStateLoadedProjectId: PROJECT_ID,
    autoStartUsed: PROJECT_ID,
  }));
  assert.equal(result, false, "同项目已经跑过一次后不能再起跑");
});

test("Gate 3: 异步 lookup 未完成（sentinel 仍为 null）→ 拒绝", () => {
  // 场景：project 刚被打开，planning.state() 还没回来；sentinel 仍是 null。
  // 这是修复的核心：原版 effect 在 planningState=null 时会立刻起跑，本版本必须拒绝。
  const result = shouldAutoStartPlanning(baseInputs({
    planningState: null,
    planningStateLoadedProjectId: null,
    autoStartUsed: null,
  }));
  assert.equal(result, false, "lookup 还没回来时绝不能起跑");
});

test("Gate 3b: sentinel 指向别的项目（切换中途）→ 拒绝", () => {
  // 场景：上一个项目的 lookup 完成了，但当前项目还没 lookup；sentinel 是上一个项目 id。
  const result = shouldAutoStartPlanning(baseInputs({
    planningState: null,
    planningStateLoadedProjectId: OTHER_PROJECT_ID,
    projectId: PROJECT_ID,
    autoStartUsed: null,
  }));
  assert.equal(result, false, "sentinel 不匹配当前 projectId 时拒绝起跑");
});

test("Gate 4: 已存在用户消息 / itinerary / 无 AI Key → 拒绝", () => {
  // 短路条件：sentinel 即使匹配也不能起跑这些场景。
  assert.equal(shouldAutoStartPlanning(baseInputs({
    hasUserMessages: true,
    planningStateLoadedProjectId: PROJECT_ID,
  })), false, "已存在用户消息时不起跑");

  assert.equal(shouldAutoStartPlanning(baseInputs({
    hasItinerary: true,
    planningStateLoadedProjectId: PROJECT_ID,
  })), false, "itinerary 已有内容时不起跑");

  assert.equal(shouldAutoStartPlanning(baseInputs({
    hasAiKey: false,
    planningStateLoadedProjectId: PROJECT_ID,
  })), false, "未配置 AI Key 时不起跑");

  assert.equal(shouldAutoStartPlanning(baseInputs({
    hasProject: false,
    planningStateLoadedProjectId: PROJECT_ID,
  })), false, "没有项目时不起跑");
});

test("Gate 5: 模拟 lookup 链路 — sentinel 从 null → match 时切换", () => {
  // 场景：用户先打开项目 A（sentinel=null），切换到 B，再切回 A。
  // 模拟时序：
  //  1) t=0: projectId=A, sentinel=null → 应拒绝
  //  2) t=1: projectId=B, sentinel=null → 应拒绝（B 的 lookup 还没回来）
  //  3) t=2: projectId=B, sentinel=B, planningState=null → 应允许一次
  //  4) t=3: projectId=B, sentinel=B, autoStartUsed=B → 应拒绝（已用过）
  //  5) t=4: projectId=A, sentinel=A, planningState=failed → 应拒绝（老项目失败）
  // 这一组断言对应「切换项目 + sentinel 重置 + lookup 完成」的完整生命周期。
  assert.equal(shouldAutoStartPlanning(baseInputs({
    projectId: PROJECT_ID,
    planningStateLoadedProjectId: null,
    planningState: null,
    autoStartUsed: null,
  })), false, "t=0: A 项目 lookup 未完成");

  assert.equal(shouldAutoStartPlanning(baseInputs({
    projectId: OTHER_PROJECT_ID,
    planningStateLoadedProjectId: null,
    planningState: null,
    autoStartUsed: null,
  })), false, "t=1: B 项目刚切换，lookup 未完成");

  assert.equal(shouldAutoStartPlanning(baseInputs({
    projectId: OTHER_PROJECT_ID,
    planningStateLoadedProjectId: OTHER_PROJECT_ID,
    planningState: null,
    autoStartUsed: null,
  })), true, "t=2: B 项目 lookup 返回 undefined 后允许一次");

  assert.equal(shouldAutoStartPlanning(baseInputs({
    projectId: OTHER_PROJECT_ID,
    planningStateLoadedProjectId: OTHER_PROJECT_ID,
    planningState: null,
    autoStartUsed: OTHER_PROJECT_ID,
  })), false, "t=3: B 项目已经 auto-start 过");

  assert.equal(shouldAutoStartPlanning(baseInputs({
    projectId: PROJECT_ID,
    planningStateLoadedProjectId: PROJECT_ID,
    planningState: makeState({ status: "failed", projectId: PROJECT_ID }),
    autoStartUsed: null,
  })), false, "t=4: 回到失败项目 A，绝不能再次自动起跑");
});

test("Gate 6: 决策纯函数 — 输入不变则输出不变（可缓存、可重复调用）", () => {
  const inputs = baseInputs({
    planningState: null,
    planningStateLoadedProjectId: PROJECT_ID,
    autoStartUsed: null,
  });
  const first = shouldAutoStartPlanning(inputs);
  const second = shouldAutoStartPlanning(inputs);
  const third = shouldAutoStartPlanning({ ...inputs });
  assert.equal(first, true);
  assert.equal(second, true);
  assert.equal(third, true);
  // 纯函数保证 effect 重复跑不会因为对象身份变化产生副作用。
});