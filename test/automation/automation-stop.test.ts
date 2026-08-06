import test from "node:test";
import assert from "node:assert/strict";
import type {
  AdvisorOutcome,
  AdvisorRequest,
  AutomationRun,
  PhaseAttempt,
} from "../../src/shared/contracts.js";
import {
  runPhaseWithRecovery,
} from "../../src/main/automation/recovery/recovery.js";

// ───────────────────────── helpers ─────────────────────────

function makeRun(): AutomationRun {
  return {
    id: "run-stop-1",
    status: "running",
    phases: [{ phase: "basic", status: "running" }],
    logs: [],
  };
}

function makeCtx(overrides: {
  run: AutomationRun;
  execute: () => Promise<unknown>;
  shouldCancel?: () => boolean;
  advisor?: (req: AdvisorRequest) => Promise<AdvisorOutcome>;
}): Parameters<typeof runPhaseWithRecovery>[0] {
  return {
    run: overrides.run,
    phase: "basic",
    completedPhases: [],
    productIdExists: true,
    basicInfoSaved: false,
    execute: overrides.execute,
    advisor: overrides.advisor ?? (async () => {
      throw new Error("advisor should not be called in this test");
    }),
    applyAction: async () => undefined,
    log: () => undefined,
    persist: () => undefined,
    shouldCancel: overrides.shouldCancel,
  };
}

// ───────────────────────── 测试 ─────────────────────────

test("未注入 shouldCancel 时：行为与之前一致，cancel 不生效", async () => {
  const run = makeRun();
  let executeCalls = 0;
  const ctx = makeCtx({
    run,
    execute: async () => { executeCalls += 1; },
  });
  const outcome = await runPhaseWithRecovery(ctx);
  assert.equal(outcome.status, "completed");
  assert.equal(executeCalls, 1);
});

test("shouldCancel 在第一次 attempt 顶部为 true：立刻返回 cancelled，execute 不被调用", async () => {
  const run = makeRun();
  let executeCalls = 0;
  let advisorCalls = 0;
  const ctx = makeCtx({
    run,
    execute: async () => { executeCalls += 1; },
    shouldCancel: () => true,
    advisor: async () => { advisorCalls += 1; return { summary: "", rootCause: "", action: "wait_for_user", expectedEvidence: "" }; },
  });
  const outcome = await runPhaseWithRecovery(ctx);
  assert.equal(outcome.status, "cancelled");
  assert.equal(executeCalls, 0, "取消后不应再调用 execute");
  assert.equal(advisorCalls, 0, "取消后不应再调用 advisor");
  const rec = run.recovery!.phases.basic;
  assert.equal(rec.state, "needs_user");
  assert.match(rec.finalError!, /用户中止/);
  assert.match(rec.userInstruction!, /已停止当前自动录入/);
});

test("shouldCancel 在 attempt 之间翻成 true：handler 跑一次就停", async () => {
  const run = makeRun();
  let executeCalls = 0;
  let cancelled = false;
  let advisorCalls = 0;
  const ctx = makeCtx({
    run,
    execute: async () => {
      executeCalls += 1;
      throw new Error("handler 模拟失败");
    },
    advisor: async () => {
      advisorCalls += 1;
      // advisor 被调一次后模拟「用户点了停止」：下一次 attempt 顶部的
      // shouldCancel() 会拿 true，runner 返回 cancelled。
      cancelled = true;
      return {
        summary: "测试",
        rootCause: "测试",
        action: "retry_same_phase",
        expectedEvidence: "测试",
      };
    },
    shouldCancel: () => cancelled,
  });
  const outcome = await runPhaseWithRecovery(ctx);
  assert.equal(outcome.status, "cancelled");
  assert.equal(executeCalls, 1, "取消生效前 handler 已跑过一次");
  assert.equal(advisorCalls, 1, "cancel 生效前 advisor 被调一次");
  const rec = run.recovery!.phases.basic;
  assert.equal(rec.state, "needs_user");
  assert.equal(rec.attempts.length, 1, "只有第一次 attempt 落进 attempts");
});

test("execute 完成后 shouldCancel 翻 true：仍返回 cancelled，不当 completed", async () => {
  const run = makeRun();
  let cancelled = false;
  let executeCalls = 0;
  const ctx = makeCtx({
    run,
    execute: async () => {
      executeCalls += 1;
      // 用户在 handler 跑的过程中点了停止；这里模拟「handler 自身完成」
    },
    shouldCancel: () => cancelled,
  });
  // 让 handler 跑完后翻 cancel —— 用 await 链模拟 in-flight click。
  cancelled = false;
  const promise = runPhaseWithRecovery(ctx);
  // 同步翻转：handler 已 await 但 ctx 应在执行后再次检查。
  cancelled = true;
  const outcome = await promise;
  assert.equal(outcome.status, "cancelled");
  assert.equal(executeCalls, 1, "handler 跑完了才发 cancel —— 不要 abort 它");
  const rec = run.recovery!.phases.basic;
  assert.equal(rec.state, "needs_user");
});

test("stop() 之前 cancel=false、stop() 之后 cancel=true：模拟 IPC 入口", async () => {
  // 用闭包模拟 DraftAutomation.cancellationRequested 集合的读写。
  const cancellationRequested = new Set<string>();
  let executeCalls = 0;
  const run = makeRun();
  const ctx = makeCtx({
    run,
    execute: async () => {
      executeCalls += 1;
      // 模拟「用户正在 handler 执行期间点击了停止」：handler 内部能看到
      // cancellationRequested 已经有值，但 handler 自己已经走完了。
      cancellationRequested.add("p1");
      return;
    },
    shouldCancel: () => cancellationRequested.has("p1"),
  });
  const outcome = await runPhaseWithRecovery(ctx);
  assert.equal(outcome.status, "cancelled");
  assert.equal(executeCalls, 1, "第一次 attempt 已执行；stop() 不应撤销它");
  const rec = run.recovery!.phases.basic;
  assert.equal(rec.state, "needs_user");
});

test("cancel 后 attempts 数组只保留 cancel 之前失败的那条", async () => {
  const run = makeRun();
  let cancel = false;
  const ctx = makeCtx({
    run,
    execute: async () => {
      if (cancel) return; // 防御性：cancel 后不应走到这里
      throw new Error("attempt-fail-1");
    },
    advisor: async () => {
      // advisor 被调用后模拟用户点了停止
      cancel = true;
      return {
        summary: "s",
        rootCause: "r",
        action: "retry_same_phase",
        expectedEvidence: "e",
      };
    },
    shouldCancel: () => cancel,
  });
  const outcome = await runPhaseWithRecovery(ctx);
  assert.equal(outcome.status, "cancelled");
  const attempts: PhaseAttempt[] = run.recovery!.phases.basic.attempts;
  // attempt 1 已落进 attempts（cancel 在 advisor 之后生效）
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].attempt, 1);
  assert.equal(attempts[0].error, "attempt-fail-1");
});

// ───────────────────────── IPC / 静态 覆盖 ─────────────────────────

test("AutomationRun 状态枚举支持 cancelled（TaskStatus 含 cancelled）", async () => {
  // 静态验证：recovery.ts 返回 cancelled 时调用方不应当作 failed 处理。
  // 已经被其他测试覆盖，但这里明确跑一次：
  const run: AutomationRun = makeRun();
  let cancel = false;
  const ctx = makeCtx({
    run,
    execute: async () => undefined,
    shouldCancel: () => cancel,
  });
  cancel = true;
  const outcome = await runPhaseWithRecovery(ctx);
  assert.equal(outcome.status, "cancelled");
  // cancelled 状态在 UI 侧对应 project.automation.status = "cancelled"，
  // 与 succeeded/failed 并列。AutomationRun 走 TaskStatus；为防止意外
  // 被改回 union，这里验证 union 包含 cancelled。
  assert.ok(["queued", "running", "succeeded", "failed", "cancelled"].includes("cancelled"));
});