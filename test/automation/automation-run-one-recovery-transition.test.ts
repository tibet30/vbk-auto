/**
 * 「单阶段重新执行」成功路径 — recovery 状态从 needs_user 切到 completed 的过渡测试。
 *
 * 场景：presentation 阶段上一次失败并停留在 needs_user（带 userInstruction / attempts）。
 * 用户手动点「重新执行」→ runOnePhase 进入：
 *   1. prepareSinglePhaseRetry 把该 phase 的 recovery 重置为 { state: "running", attempts: [] }；
 *   2. runPhaseWithRecovery 跑 handler，handler 成功 → rec.state = "completed"；
 *   3. UI 派生层应当看到：
 *        - recoveryNeedsUser(run) === null（旧的 needs_user 块被清掉）；
 *        - aggregateSectionState(presentation, ...) === "done"（产品图文行变绿）；
 *        - 其他 phase 行 status 与其它 recovery 记录原封不动。
 *
 * 这组测试把「prepareSinglePhaseRetry + runPhaseWithRecovery + UI 派生」三段拼起来，
 * 让任何一处忘了清 stale needs_user 都被立刻捕获。
 */

import test from "node:test";
import assert from "node:assert/strict";
import type { AutomationRun, PhaseAttempt } from "../../src/shared/contracts.js";
import { prepareSinglePhaseRetry } from "../../src/main/automation/phase-retry.js";
import { runPhaseWithRecovery } from "../../src/main/automation/recovery/recovery.js";
import {
  aggregateSectionState,
  recoveryNeedsUser,
  VBK_NAV_SECTIONS,
} from "../../src/renderer/app/helpers/constants.js";

// ───────────────────────── helpers ─────────────────────────

const ALL_PHASES = ["basic", "presentation", "itinerary", "package"] as const;

/** 构造一个「presentation 上一次失败、其它阶段混合状态」的 AutomationRun。 */
function makePreviousFailedRun(): AutomationRun {
  const priorAttempts: PhaseAttempt[] = [
    {
      attempt: 1,
      error: "presentation 上传失败",
      at: "2026-08-11T10:00:00.000Z",
      diagnosis: {
        summary: "图片上传被拒绝",
        rootCause: "图片尺寸超过限制",
        expectedEvidence: "VBK 图文编辑器接受图片",
      },
      action: "retry_same_phase",
    },
    {
      attempt: 2,
      error: "presentation 保存超时",
      at: "2026-08-11T10:01:30.000Z",
      diagnosis: {
        summary: "保存按钮未触发",
        rootCause: "等待 save 按钮可见超时",
        expectedEvidence: "save 按钮变为 enabled",
      },
      action: "reload_and_retry_phase",
    },
  ];
  return {
    id: "run-presentation-failed",
    status: "failed",
    currentPhase: "presentation",
    phases: [
      { phase: "basic", status: "completed" },
      { phase: "presentation", status: "failed" },
      { phase: "itinerary", status: "completed" },
      { phase: "package", status: "pending" },
    ],
    logs: [
      { at: "2026-08-11T09:59:00.000Z", message: "自动录入启动", level: "info" },
      { at: "2026-08-11T10:02:00.000Z", message: "presentation 阶段失败", level: "error" },
    ],
    recovery: {
      phases: {
        presentation: {
          phase: "presentation",
          state: "needs_user",
          attempts: priorAttempts,
          attemptsHistory: [
            {
              attempt: 1,
              error: "首次图片 URL 404",
              at: "2026-08-11T09:30:00.000Z",
              diagnosis: {
                summary: "图床链接已失效",
                rootCause: "VBK CDN 已下架",
                expectedEvidence: "图床可访问",
              },
              action: "reopen_editor_and_retry_phase",
            },
          ],
          userInstruction: "请在 VBK 手动确认产品图文已保存后再次发起保存草稿。",
          finalError: "保存超时",
        },
        basic: {
          phase: "basic",
          state: "completed",
          attempts: [{ attempt: 1, error: "ok", at: "2026-08-11T09:59:30.000Z" }],
        },
        itinerary: {
          phase: "itinerary",
          state: "completed",
          attempts: [],
        },
      },
    },
  };
}

/** runOnePhase 同型的「执行器」：直接成功，不调 advisor、不抛错。 */
async function successfulExecute(): Promise<unknown> {
  return "ok";
}

/** 模拟 runOnePhase 的成功分支：恢复 run.status + run.currentPhase */
function applyCompletedOutcome(run: AutomationRun, originalRunStatus: AutomationRun["status"]): void {
  run.status = originalRunStatus === "running" ? "running" : originalRunStatus;
  run.currentPhase = undefined;
}

// ───────────────────────── 测试 ─────────────────────────

test("失败 presentation 重试成功后：recovery[presentation] 不再停留在 needs_user", async () => {
  const previous = makePreviousFailedRun();
  const originalRunStatus = previous.status;

  // step 1: prepareSinglePhaseRetry 应当重置 retry phase 的 recovery。
  const run = prepareSinglePhaseRetry(previous, [...ALL_PHASES], "presentation", "2026-08-11T11:00:00.000Z");

  assert.equal(run.status, "running");
  assert.equal(run.recovery!.phases.presentation.state, "running", "retry 入口把 recovery 临时切到 running");
  assert.equal(run.recovery!.phases.presentation.attempts.length, 0);

  // step 2: runPhaseWithRecovery 跑一个成功的 handler
  const outcome = await runPhaseWithRecovery({
    run,
    phase: "presentation",
    completedPhases: ["basic"],
    productIdExists: true,
    basicInfoSaved: true,
    execute: successfulExecute,
    advisor: async () => {
      throw new Error("成功的执行路径不应调用 advisor");
    },
    applyAction: async () => {
      throw new Error("成功的执行路径不应调用 applyAction");
    },
    log: () => undefined,
    persist: () => undefined,
  });

  assert.equal(outcome.status, "completed");
  // step 3: 模拟 runOnePhase 的成功分支
  applyCompletedOutcome(run, originalRunStatus);

  // 关键断言：recovery[presentation] 不再是 needs_user，
  // 旧的 userInstruction / finalError / attemptsHistory 全部丢失。
  const presentationRec = run.recovery!.phases.presentation;
  assert.equal(presentationRec.state, "completed", "recovery[presentation] 必须切到 completed");
  assert.notEqual(presentationRec.state, "needs_user", "不能再停在 needs_user，否则 UI 会保留旧 banner");
  assert.equal(presentationRec.attempts.length, 0, "成功的 retry 不留失败 attempts");
  assert.equal(presentationRec.userInstruction, undefined, "成功的 retry 必须清掉旧 userInstruction");
  assert.equal(presentationRec.finalError, undefined, "成功的 retry 必须清掉旧 finalError");
});

test("失败 presentation 重试成功后：recoveryNeedsUser(run) 返回 null，UI banner 消失", async () => {
  const previous = makePreviousFailedRun();
  const originalRunStatus = previous.status;

  // 模拟「点重新执行 → handler 成功」的最小路径。
  const run = prepareSinglePhaseRetry(previous, [...ALL_PHASES], "presentation", "2026-08-11T11:00:00.000Z");
  const outcome = await runPhaseWithRecovery({
    run,
    phase: "presentation",
    completedPhases: ["basic"],
    productIdExists: true,
    basicInfoSaved: true,
    execute: successfulExecute,
    advisor: async () => {
      throw new Error("unused");
    },
    applyAction: async () => undefined,
    log: () => undefined,
    persist: () => undefined,
  });
  assert.equal(outcome.status, "completed");
  applyCompletedOutcome(run, originalRunStatus);

  // UI 派生层：recoveryNeedsUser 必须返回 null。
  assert.equal(recoveryNeedsUser(run), null, "successful retry 后 UI banner 必须消失");
});

test("失败 presentation 重试成功后：aggregateSectionState(presentation) === \"done\"", async () => {
  const previous = makePreviousFailedRun();
  const originalRunStatus = previous.status;

  const run = prepareSinglePhaseRetry(previous, [...ALL_PHASES], "presentation", "2026-08-11T11:00:00.000Z");
  // 同时让 phase.status 走到 completed —— runOnePhase 的 execute 函数在这里做这件事。
  // 这里直接复刻 runOnePhase.execute 对 presentation 分支的副作用：
  run.phases[ALL_PHASES.indexOf("presentation")].status = "completed";

  const outcome = await runPhaseWithRecovery({
    run,
    phase: "presentation",
    completedPhases: ["basic"],
    productIdExists: true,
    basicInfoSaved: true,
    execute: async () => {
      // 模拟 runOnePhase.execute 在 handler 成功后改 phase.status
      run.phases[ALL_PHASES.indexOf("presentation")].status = "completed";
    },
    advisor: async () => {
      throw new Error("unused");
    },
    applyAction: async () => undefined,
    log: () => undefined,
    persist: () => undefined,
  });
  assert.equal(outcome.status, "completed");
  applyCompletedOutcome(run, originalRunStatus);

  const presentationSection = VBK_NAV_SECTIONS.find((s) => s.key === "presentation");
  assert.ok(presentationSection, "presentation section 必须存在");
  const state = aggregateSectionState(
    presentationSection!,
    run.phases,
    run.recovery!.phases,
  );
  assert.equal(state, "done", "产品图文行必须变 done/绿");
});

test("失败 presentation 重试成功后：其它 phase 的状态与 recovery 全部保留", async () => {
  const previous = makePreviousFailedRun();
  const originalRunStatus = previous.status;
  const beforePhases = previous.phases.map((p) => ({ phase: p.phase, status: p.status }));
  const beforeRecovery = JSON.parse(JSON.stringify(previous.recovery!.phases));

  const run = prepareSinglePhaseRetry(previous, [...ALL_PHASES], "presentation", "2026-08-11T11:00:00.000Z");
  const outcome = await runPhaseWithRecovery({
    run,
    phase: "presentation",
    completedPhases: ["basic"],
    productIdExists: true,
    basicInfoSaved: true,
    execute: successfulExecute,
    advisor: async () => {
      throw new Error("unused");
    },
    applyAction: async () => undefined,
    log: () => undefined,
    persist: () => undefined,
  });
  assert.equal(outcome.status, "completed");
  applyCompletedOutcome(run, originalRunStatus);

  // 1) 其它 phase 的 status 必须原封不动 —— 仅有 presentation 是被 retry 的；
  //    runOnePhase.execute 对非 retry 的 phase 不动它们的 status。
  for (const before of beforePhases) {
    if (before.phase === "presentation") continue;
    const after = run.phases.find((p) => p.phase === before.phase);
    assert.ok(after, `${before.phase} 必须仍然在 run.phases 里`);
    assert.equal(after!.status, before.status, `${before.phase} 的 status 必须保留为 ${before.status}`);
  }

  // 2) 其它 phase 的 recovery 必须原封不动：basic / itinerary 的 state / attempts 不能被改写。
  assert.equal(run.recovery!.phases.basic.state, beforeRecovery.basic.state);
  assert.deepEqual(run.recovery!.phases.basic.attempts, beforeRecovery.basic.attempts);
  assert.equal(run.recovery!.phases.itinerary.state, beforeRecovery.itinerary.state);
  assert.deepEqual(run.recovery!.phases.itinerary.attempts, beforeRecovery.itinerary.attempts);

  // 3) itinerary 区段仍是 done（被 retry 的 presentation 不会污染 itinerary 区段）。
  const itinerarySection = VBK_NAV_SECTIONS.find((s) => s.key === "itinerary");
  assert.ok(itinerarySection);
  const itineraryState = aggregateSectionState(
    itinerarySection!,
    run.phases,
    run.recovery!.phases,
  );
  assert.equal(itineraryState, "done", "itinerary 区段应当保持 done");
});

test("失败 presentation 重试成功后：presentation 区段不再是 failed / running（UI 上不再有 stale 阻塞块）", async () => {
  const previous = makePreviousFailedRun();
  const originalRunStatus = previous.status;

  const run = prepareSinglePhaseRetry(previous, [...ALL_PHASES], "presentation", "2026-08-11T11:00:00.000Z");
  const outcome = await runPhaseWithRecovery({
    run,
    phase: "presentation",
    completedPhases: ["basic"],
    productIdExists: true,
    basicInfoSaved: true,
    execute: async () => {
      run.phases[ALL_PHASES.indexOf("presentation")].status = "completed";
    },
    advisor: async () => {
      throw new Error("unused");
    },
    applyAction: async () => undefined,
    log: () => undefined,
    persist: () => undefined,
  });
  assert.equal(outcome.status, "completed");
  applyCompletedOutcome(run, originalRunStatus);

  const presentationSection = VBK_NAV_SECTIONS.find((s) => s.key === "presentation");
  const state = aggregateSectionState(
    presentationSection!,
    run.phases,
    run.recovery!.phases,
  );
  assert.notEqual(state, "failed", "presentation 区段不应再被标 failed");
  assert.notEqual(state, "running", "presentation 区段不应再被标 running");
  assert.notEqual(state, "pending", "presentation 区段不应再被标 pending");
  assert.equal(state, "done", "presentation 区段应当变 done/绿");
});

/**
 * 同 run 内 itinerary 也停留在 needs_user，presentation 成功 retry 后：
 *   - presentation 区段必须仍是 done（不能被 itinerary 的 stale needs_user 污染）；
 *   - itinerary 区段保持 failed（旧失败未被 retry，banner / 红点是合理的）；
 *   - recoveryNeedsUser 仍指向 itinerary（banner 属于 itinerary 而非 presentation）。
 *
 * 这是「presentation 行变绿」最容易被误判的场景：aggregateSectionState 的 needs_user
 * 短路只看 phaseNames 是否包含，只要 itinerary 不在 presentation 的 phaseNames 里，
 * 它就不能让 presentation 区段变红。
 */
test("失败 presentation 重试成功：其它 phase 的 stale needs_user 不能污染 presentation 区段", async () => {
  const previous: AutomationRun = {
    ...makePreviousFailedRun(),
    recovery: {
      phases: {
        presentation: {
          phase: "presentation",
          state: "needs_user",
          attempts: [{ attempt: 1, error: "presentation 上传失败", at: "2026-08-11T10:00:00.000Z" }],
          userInstruction: "请在 VBK 手动确认产品图文已保存后再次发起保存草稿。",
          finalError: "保存超时",
        },
        itinerary: {
          phase: "itinerary",
          state: "needs_user",
          attempts: [{ attempt: 1, error: "行程页签解析失败", at: "2026-08-11T10:00:30.000Z" }],
          userInstruction: "请手动检查行程描述后再次保存草稿。",
          finalError: "tab 解析失败",
        },
      },
    },
  };
  const originalRunStatus = previous.status;

  const run = prepareSinglePhaseRetry(previous, [...ALL_PHASES], "presentation", "2026-08-11T11:00:00.000Z");
  const outcome = await runPhaseWithRecovery({
    run,
    phase: "presentation",
    completedPhases: ["basic"],
    productIdExists: true,
    basicInfoSaved: true,
    execute: async () => {
      run.phases[ALL_PHASES.indexOf("presentation")].status = "completed";
    },
    advisor: async () => {
      throw new Error("unused");
    },
    applyAction: async () => undefined,
    log: () => undefined,
    persist: () => undefined,
  });
  assert.equal(outcome.status, "completed");
  applyCompletedOutcome(run, originalRunStatus);

  const presentationSection = VBK_NAV_SECTIONS.find((s) => s.key === "presentation");
  const itinerarySection = VBK_NAV_SECTIONS.find((s) => s.key === "itinerary");
  assert.ok(presentationSection && itinerarySection);

  // 关键断言 1：presentation 区段仍为 done，不被 itinerary 的 stale needs_user 污染。
  const presentationState = aggregateSectionState(
    presentationSection!,
    run.phases,
    run.recovery!.phases,
  );
  assert.equal(presentationState, "done", "presentation 区段必须保持 done（itinerary 的 needs_user 不应污染）");

  // 关键断言 2：itinerary 区段保持 failed（它没被 retry，banner 是合理的）。
  const itineraryState = aggregateSectionState(
    itinerarySection!,
    run.phases,
    run.recovery!.phases,
  );
  assert.equal(itineraryState, "failed", "itinerary 区段应保持 failed / 红点");

  // 关键断言 3：recoveryNeedsUser 仍指向 itinerary —— banner 属于 itinerary 而非 presentation，
  // 不会让用户误以为 presentation 还在 blocked。
  const blocked = recoveryNeedsUser(run);
  assert.ok(blocked);
  assert.equal(blocked!.phase, "itinerary", "banner 应只指向 itinerary");
});
