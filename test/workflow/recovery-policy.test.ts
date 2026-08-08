/**
 * recovery-policy 纯函数测试。
 *
 * 覆盖核心修复：当用户在项目详情页点击"工作台"/"项目"/"设置"/"操作日志"
 * 按钮时，derived.ts 的 recovery effect 不应再把 localStorage 里的
 * activeProjectId 拉回项目详情。验证来源 UUID：f5e73c0b-84e7-4425-a361-7796ff21cf44。
 *
 * 重要：本文件不动 derived.ts，也不依赖 jsdom / RTL；只针对
 * shouldAttemptRecentProjectRecovery 的输入/输出。derived.ts 的 effect 行为
 * 由端到端验证覆盖（npm run dev + 手动复现），本测试保证决策表稳定。
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  shouldAttemptRecentProjectRecovery,
  simulateRecoveryEffectTick,
  type RecoveryInputs,
  type RecoveryView,
} from "../../src/renderer/app/state/recovery-policy.js";

const PROJECT_ID = "f5e73c0b-84e7-4425-a361-7796ff21cf44";

function baseInputs(overrides: Partial<RecoveryInputs> = {}): RecoveryInputs {
  return {
    hasApi: true,
    view: "workspace",
    hasProject: false,
    hasActiveProjectId: true,
    hasAttempted: false,
    ...overrides,
  };
}

test("Gate 1: 启动场景 workspace + 有效 activeProjectId + project 为空 → 允许恢复", () => {
  // 场景：刷新 / 重启后 localStorage 有残留 id，view 为 workspace，用户尚未手动
  // 开项目。期望：policy 放行，恢复 effect 会去拉权威数据。
  assert.equal(
    shouldAttemptRecentProjectRecovery(baseInputs()),
    true,
    "正常启动应允许恢复最近项目",
  );
});

test("Gate 2: 切到 projects 视图（带 activeProjectId）→ 不恢复", () => {
  // 场景：用户在项目详情页点"项目"按钮 → setProject(null) + setView("projects")。
  // 期望：view !== "workspace" 短路，恢复不发生，UI 留在 projects 列表。
  assert.equal(
    shouldAttemptRecentProjectRecovery(baseInputs({ view: "projects" as RecoveryView })),
    false,
    "切到 projects 视图时绝不恢复",
  );
});

test("Gate 3: 切到 settings 视图（带 activeProjectId）→ 不恢复", () => {
  // 场景：用户在项目详情页点"设置"按钮 → setProject(null) + setView("settings")。
  // 期望：policy 短路，不调用 api().projects.get，也不回填 project。
  assert.equal(
    shouldAttemptRecentProjectRecovery(baseInputs({ view: "settings" as RecoveryView })),
    false,
    "切到 settings 视图时绝不恢复",
  );
});

test("Gate 4: 切到 operation-log 视图（带 activeProjectId）→ 不恢复", () => {
  // 场景：用户在项目详情页点"操作日志"按钮 → setProject(null) + setView("operation-log")。
  // 期望：policy 短路，不调用恢复，也不回填。
  assert.equal(
    shouldAttemptRecentProjectRecovery(baseInputs({ view: "operation-log" as RecoveryView })),
    false,
    "切到 operation-log 视图时绝不恢复",
  );
});

test("Gate 5: 点'工作台'后被用户已 attempt 过 → 同一会话内不再次恢复", () => {
  // 场景：用户在项目详情页点"工作台"按钮 → setProject(null) + setView("workspace")。
  // 此时 view 仍是 workspace，如果只看 view 会再次触发恢复，把刚被用户清掉
  // 的项目又塞回详情页。hasAttempted 阻止重跑。
  // 期望：hasAttempted=true → 拒绝恢复。
  assert.equal(
    shouldAttemptRecentProjectRecovery(baseInputs({ hasAttempted: true })),
    false,
    "同会话已尝试过一次后不能再恢复（避免点'工作台'后又被 effect 拉回详情）",
  );
});

test("Gate 6: project 已存在（用户主动开了项目）→ 不恢复", () => {
  // 场景：用户在初始化期间手动 openProject(B)。期望：放弃恢复，
  // 与 derived.ts 原有的 `if (project) return;` 一致。
  assert.equal(
    shouldAttemptRecentProjectRecovery(baseInputs({ hasProject: true })),
    false,
    "用户已手动开项目时不恢复",
  );
});

test("Gate 7: localStorage 无 activeProjectId → 不恢复", () => {
  // 场景：首次启动 / 用户之前没开过项目。期望：activeProjectId 为 null 时不发起请求。
  assert.equal(
    shouldAttemptRecentProjectRecovery(baseInputs({ hasActiveProjectId: false })),
    false,
    "无 activeProjectId 时不恢复",
  );
});

test("Gate 8: preload 尚未注入（api() === undefined）→ 不恢复", () => {
  // 场景：Electron 预加载脚本未生效。期望：跳过恢复，避免空指针。
  assert.equal(
    shouldAttemptRecentProjectRecovery(baseInputs({ hasApi: false })),
    false,
    "api 不可用时不恢复",
  );
});

test("Gate 9: 模拟完整链路 — 启动恢复 → 点'工作台' → 点'项目' → 点'设置'", () => {
  // 场景时序：
  //   t=0  启动，view=workspace, project=null, activeProjectId=A → 允许恢复（首次）
  //   t=1  恢复完成，project=A → 不再尝试恢复（Gate 6：project 已存在）
  //   t=2  用户点"工作台"：project=null, view=workspace, activeProjectId=A
  //         → hasAttempted=true → 拒绝恢复（核心修复：避免被拉回详情）
  //   t=3  用户点"项目"：project=null, view=projects, activeProjectId=null（sync 清掉）
  //         → view 非 workspace + activeProjectId 为空 → 拒绝恢复
  //   t=4  用户点"设置"：project=null, view=settings, activeProjectId=null
  //         → view 非 workspace → 拒绝恢复
  assert.equal(
    shouldAttemptRecentProjectRecovery(baseInputs({
      view: "workspace", hasProject: false, hasActiveProjectId: true, hasAttempted: false,
    })),
    true,
    "t=0: 启动恢复应允许",
  );
  assert.equal(
    shouldAttemptRecentProjectRecovery(baseInputs({
      view: "workspace", hasProject: true, hasActiveProjectId: true, hasAttempted: false,
    })),
    false,
    "t=1: project 已存在时不应再尝试",
  );
  assert.equal(
    shouldAttemptRecentProjectRecovery(baseInputs({
      view: "workspace", hasProject: false, hasActiveProjectId: true, hasAttempted: true,
    })),
    false,
    "t=2: 点'工作台'后 view=workspace 但 hasAttempted=true，必须拒绝",
  );
  assert.equal(
    shouldAttemptRecentProjectRecovery(baseInputs({
      view: "projects", hasProject: false, hasActiveProjectId: false, hasAttempted: true,
    })),
    false,
    "t=3: 点'项目'后 view=projects 且 activeProjectId 被清，必须拒绝",
  );
  assert.equal(
    shouldAttemptRecentProjectRecovery(baseInputs({
      view: "settings", hasProject: false, hasActiveProjectId: false, hasAttempted: true,
    })),
    false,
    "t=4: 点'设置'后 view=settings，必须拒绝",
  );
});

test("Gate 10: 决策纯函数 — 输入不变则输出不变（可缓存、可重复调用）", () => {
  // 同样的输入重复调用必须返回同样的结果，且不修改任何字段（policy 本身不持有
  // 状态，hasAttempted 是 caller 持有的 ref，本函数不感知）。
  const inputs = baseInputs();
  assert.equal(shouldAttemptRecentProjectRecovery(inputs), true);
  assert.equal(shouldAttemptRecentProjectRecovery(inputs), true);
  assert.equal(shouldAttemptRecentProjectRecovery({ ...inputs }), true);
  // 输入仍为合法值：纯函数不修改入参对象。
  assert.equal(inputs.hasAttempted, false);
  assert.equal(inputs.hasActiveProjectId, true);
});

test("Gate 11: 用户复现 UUID 在所有允许场景下都会被发出去", () => {
  // 验证从问题报告里来的 UUID `f5e73c0b-84e7-4425-a361-7796ff21cf44` 不会因
  // 字符串特性被错误短路（仅断言 policy 函数接受该值作为 activeProjectId 路径）。
  // 真正的"发送"动作由 derived.ts 的 effect 完成；这里只确认 gate 行为一致。
  const inputs = baseInputs({
    hasActiveProjectId: true,
    hasAttempted: false,
    view: "workspace",
  });
  // policy 不直接读 activeProjectId 字符串，只看 hasActiveProjectId 布尔；
  // 但 derived.ts 会用同一字符串发起 api().projects.get(targetId)。
  // 这里通过反向断言：如果 policy 拒绝，则 derived.ts 也不会发请求，UUID 不会泄漏。
  assert.equal(shouldAttemptRecentProjectRecovery(inputs), true, "workspace + 有效 id 必须放行");
  // 反向：被 attempt 过一次后必须拒绝，避免该 UUID 被反复发出去。
  assert.equal(
    shouldAttemptRecentProjectRecovery({ ...inputs, hasAttempted: true }),
    false,
    "已 attempt 过该 UUID 对应的 id 后必须拒绝",
  );
  // 注：activeProjectId 字符串本身不进 policy；UUID 在 derived.ts 通过
  // `recoveryAttemptedRef.current = true` 被会话级屏蔽，而不是按 UUID 去重。
  void PROJECT_ID;
});

test("Gate 12: 启动恢复机会的消费契约 — 用户手动打开项目后必须消耗本次会话的恢复机会", () => {
  // 场景（用户报告遗漏路径）：
  //   t=0  启动，view=workspace, project=null, activeProjectId=A, hasAttempted=false
  //         → policy 放行，effect 会把 recoveryAttemptedRef 置 true 后发起请求。
  //   t=1  用户在请求未到 in-flight 完成前，从项目列表手动 openProject(A)。
  //         project: null → A，effect 重跑。policy 现在 hasProject=true 拒绝。
  //   t=2  关键：derived.ts effect 在 hasProject=true 短路分支必须把
  //         recoveryAttemptedRef 置 true —— 把本会话的恢复机会消费掉，
  //         这样 t=3 用户点"工作台"清掉 project 后再回到 workspace，
  //         policy 在 hasAttempted=true 路径上短路，不会把 A 重新塞回去。
  //   t=3  用户 setProject(null) + setView("workspace")。
  //         project=null, view=workspace, hasAttempted=true → 拒绝（核心防回填）。
  //
  // 这里直接驱动 derived.ts 的 effect tick 模拟器，断言每次 tick 之后的
  // hasAttempted 状态序列与"是否发起请求"决策必须吻合。
  // 失败模式（修复前）：t=1 时 effect 因 hasProject=true 短路后 hasAttempted 仍是 false；
  // 走到 t=3 时 effect 会再次放行，把 A 拉回详情。
  let hasAttempted = false;
  const requests: string[] = [];

  const tick = (state: { view: RecoveryView; hasProject: boolean; hasActiveProjectId: boolean }): void => {
    const decision = simulateRecoveryEffectTick({
      hasApi: true,
      view: state.view,
      hasProject: state.hasProject,
      hasActiveProjectId: state.hasActiveProjectId,
      hasAttempted,
    });
    hasAttempted = decision.nextHasAttempted;
    if (decision.shouldRequest && state.hasActiveProjectId) {
      requests.push("A");
    }
  };

  // t=0 启动：放行，发起一次请求，hasAttempted 翻为 true
  tick({ view: "workspace", hasProject: false, hasActiveProjectId: true });
  assert.deepEqual(requests, ["A"], "t=0 启动恢复必须发起一次请求");
  assert.equal(hasAttempted, true, "t=0 完成后 hasAttempted 必须为 true");

  // t=1 用户手动 openProject(A)：project 从 null → A，effect 因 hasProject=true 短路
  tick({ view: "workspace", hasProject: true, hasActiveProjectId: true });
  assert.deepEqual(requests, ["A"], "t=1 手动开项目时不应重复发起请求");
  assert.equal(
    hasAttempted,
    true,
    "t=1 hasProject=true 短路时必须把 hasAttempted 置 true（消费本会话恢复机会）",
  );

  // t=2 用户点'项目'切走：view=projects，不应影响 hasAttempted
  tick({ view: "projects", hasProject: false, hasActiveProjectId: true });
  assert.deepEqual(requests, ["A"], "t=2 切到 projects 不应发起请求");
  assert.equal(hasAttempted, true, "t=2 切走后 hasAttempted 仍应为 true");

  // t=3 用户点'工作台'回到 workspace + project 已清：核心防回填
  tick({ view: "workspace", hasProject: false, hasActiveProjectId: true });
  assert.deepEqual(
    requests,
    ["A"],
    "t=3 关键：手动开项目后回 workspace，绝不应再发起请求把 A 拉回详情",
  );
  assert.equal(hasAttempted, true, "t=3 hasAttempted 保持 true");

  // 对照：全新会话（hasAttempted=false 起步）时启动恢复仍可放行。
  hasAttempted = false;
  requests.length = 0;
  tick({ view: "workspace", hasProject: false, hasActiveProjectId: true });
  assert.deepEqual(requests, ["A"], "新会话启动恢复必须放行（与 Gate 1 一致）");
  assert.equal(hasAttempted, true, "新会话 t=0 后 hasAttempted 翻为 true");
});
