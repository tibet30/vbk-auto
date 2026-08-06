import test from "node:test";
import assert from "node:assert/strict";
import type {
  AdvisorOutcome,
  AdvisorRequest,
  AutomationRun,
} from "../../src/shared/contracts.js";
import {
  runPhaseWithRecovery,
  MAX_PHASE_ATTEMPTS,
} from "../../src/main/automation/recovery/recovery.js";

// ───────────────────────── helpers ─────────────────────────

function makeRun(): AutomationRun {
  return {
    id: "run-1",
    status: "running",
    phases: [],
    logs: [],
  };
}

interface SpyAdvisor {
  fn: (req: AdvisorRequest) => Promise<AdvisorOutcome>;
  calls: AdvisorRequest[];
}

function makeSpyAdvisor(): SpyAdvisor {
  const calls: AdvisorRequest[] = [];
  const fn = async (req: AdvisorRequest): Promise<AdvisorOutcome> => {
    calls.push(req);
    // 不给具体 action：始终让 applyAction 退化为 retry_same_phase，
    // 本测试只关心 attempts 归档，不关心 advisor 决策分支。
    return {
      summary: `诊断 ${req.attempt}`,
      rootCause: `根因 ${req.attempt}`,
      action: "retry_same_phase",
      expectedEvidence: `证据 ${req.attempt}`,
    };
  };
  return { fn, calls };
}

interface FailingExecute {
  fn: () => Promise<unknown>;
}

function makeFailingExecute(): FailingExecute {
  return {
    fn: async () => {
      throw new Error("always fails");
    },
  };
}

interface CtxOverrides {
  run: AutomationRun;
}

function makeCtx(overrides: CtxOverrides): Parameters<typeof runPhaseWithRecovery>[0] {
  return {
    run: overrides.run,
    phase: "basic",
    completedPhases: [],
    productIdExists: true,
    basicInfoSaved: false,
    execute: makeFailingExecute().fn,
    advisor: async () => {
      throw new Error("advisor should be overridden by test");
    },
    applyAction: async () => undefined,
    log: () => undefined,
    persist: () => undefined,
  };
}

// ───────────────────────── 测试 ─────────────────────────

test("第二次进入 phase：上轮的 3 条 attempts 归档到 attemptsHistory，本轮的 attempts 是新 3 条", async () => {
  const run: AutomationRun = makeRun();
  const ctx = makeCtx({ run });
  const advisor = makeSpyAdvisor();
  ctx.advisor = advisor.fn;

  // 第一轮：3 次失败 → needs_user
  const firstOutcome = await runPhaseWithRecovery(ctx);
  assert.equal(firstOutcome.status, "needs_user");
  let rec = run.recovery?.phases.basic;
  assert.ok(rec, "first round recovery record exists");
  assert.equal(rec!.state, "needs_user");
  assert.equal(rec!.attempts.length, MAX_PHASE_ATTEMPTS);
  assert.equal(rec!.attempts[0].attempt, 1);
  assert.equal(rec!.attempts[2].attempt, MAX_PHASE_ATTEMPTS);
  // 第一轮结束时还没有历史（之前从未进入过 phase）
  assert.equal(rec!.attemptsHistory, undefined);

  // 第二轮：再次进入 phase → 归档 + 重置
  const secondOutcome = await runPhaseWithRecovery(ctx);
  assert.equal(secondOutcome.status, "needs_user");
  rec = run.recovery?.phases.basic;
  assert.ok(rec);
  assert.equal(rec!.state, "needs_user");
  // 第二轮的 attempts 是新 3 条
  assert.equal(rec!.attempts.length, MAX_PHASE_ATTEMPTS);
  assert.equal(rec!.attempts[0].attempt, 1);
  assert.equal(rec!.attempts[2].attempt, MAX_PHASE_ATTEMPTS);
  // attemptsHistory 保留了第一轮的 3 条
  assert.ok(rec!.attemptsHistory, "attemptsHistory should be present after second round");
  assert.equal(rec!.attemptsHistory!.length, MAX_PHASE_ATTEMPTS);
  assert.equal(rec!.attemptsHistory![0].attempt, 1);
  assert.equal(rec!.attemptsHistory![2].attempt, MAX_PHASE_ATTEMPTS);
  // 第二轮 advisor 调用次数：第一轮 2 次（attempt 1、2），第二轮同样 2 次
  assert.equal(advisor.calls.length, MAX_PHASE_ATTEMPTS - 1 + MAX_PHASE_ATTEMPTS - 1);
  // history 与 current 是不同对象引用，避免后续被覆盖
  assert.notStrictEqual(rec!.attemptsHistory, rec!.attempts);
});

test("连续三次进入 phase：attemptsHistory 累积前两轮共 6 条", async () => {
  const run: AutomationRun = makeRun();
  const ctx = makeCtx({ run });
  const advisor = makeSpyAdvisor();
  ctx.advisor = advisor.fn;

  for (let round = 1; round <= 3; round += 1) {
    const outcome = await runPhaseWithRecovery(ctx);
    assert.equal(outcome.status, "needs_user", `round ${round} 仍 needs_user`);
  }
  const rec = run.recovery?.phases.basic;
  assert.ok(rec);
  // 第三轮的 attempts：3 条
  assert.equal(rec!.attempts.length, MAX_PHASE_ATTEMPTS);
  // attemptsHistory：第一轮 3 条 + 第二轮 3 条 = 6 条
  assert.ok(rec!.attemptsHistory);
  assert.equal(rec!.attemptsHistory!.length, MAX_PHASE_ATTEMPTS * 2);
});

test("phase 成功完成后再次进入 phase → 不归档，attemptsHistory 保持为空", async () => {
  const run: AutomationRun = makeRun();

  // 第一次：成功 → state=completed
  const succeedExecute = async () => undefined;
  const ctx: Parameters<typeof runPhaseWithRecovery>[0] = {
    run,
    phase: "basic",
    completedPhases: [],
    productIdExists: true,
    basicInfoSaved: false,
    execute: succeedExecute,
    advisor: async () => {
      throw new Error("advisor should not be called on success");
    },
    applyAction: async () => undefined,
    log: () => undefined,
    persist: () => undefined,
  };
  const firstOutcome = await runPhaseWithRecovery(ctx);
  assert.equal(firstOutcome.status, "completed");
  let rec = run.recovery?.phases.basic;
  assert.ok(rec);
  assert.equal(rec!.state, "completed");
  assert.equal(rec!.attempts.length, 0);
  assert.equal(rec!.attemptsHistory, undefined);

  // 第二次：再次成功 → completed state 不应触发归档
  const secondOutcome = await runPhaseWithRecovery(ctx);
  assert.equal(secondOutcome.status, "completed");
  rec = run.recovery?.phases.basic;
  assert.ok(rec);
  assert.equal(rec!.state, "completed");
  assert.equal(rec!.attempts.length, 0);
  // 关键断言：成功状态下重入 phase，attemptsHistory 不会被错误填充
  assert.equal(rec!.attemptsHistory, undefined);
});

test("归档保留 diagnosis（rootCause/expectedEvidence/action）字段", async () => {
  const run: AutomationRun = makeRun();
  const ctx = makeCtx({ run });
  ctx.advisor = async (): Promise<AdvisorOutcome> => ({
    summary: "诊断 A",
    rootCause: "根因 A",
    action: "reload_and_retry_phase",
    expectedEvidence: "证据 A",
  });

  // 第一轮失败
  await runPhaseWithRecovery(ctx);
  const rec1 = run.recovery?.phases.basic;
  assert.equal(rec1!.attempts[0].diagnosis?.rootCause, "根因 A");
  assert.equal(rec1!.attempts[0].action, "reload_and_retry_phase");

  // 第二轮失败（用不同 advisor 输出便于验证 history 字段）
  ctx.advisor = async (): Promise<AdvisorOutcome> => ({
    summary: "诊断 B",
    rootCause: "根因 B",
    action: "reopen_editor_and_retry_phase",
    expectedEvidence: "证据 B",
  });
  await runPhaseWithRecovery(ctx);
  const rec2 = run.recovery?.phases.basic;
  assert.ok(rec2);
  // attemptsHistory 的诊断仍是第一轮的 A 字段
  assert.equal(rec2!.attemptsHistory![0].diagnosis?.rootCause, "根因 A");
  assert.equal(rec2!.attemptsHistory![0].action, "reload_and_retry_phase");
  // attempts 是第二轮的 B 字段
  assert.equal(rec2!.attempts[0].diagnosis?.rootCause, "根因 B");
  assert.equal(rec2!.attempts[0].action, "reopen_editor_and_retry_phase");
});

test("归档后修改 rec.attempts 不应影响 attemptsHistory（数据隔离）", async () => {
  const run: AutomationRun = makeRun();
  const ctx = makeCtx({ run });
  const advisor = makeSpyAdvisor();
  ctx.advisor = advisor.fn;

  // 第一轮失败 → 进入 needs_user（此时还没有 attemptsHistory）
  await runPhaseWithRecovery(ctx);
  // 第二轮失败 → 进入 needs_user，此时 attemptsHistory 才有第一轮 3 条
  await runPhaseWithRecovery(ctx);
  const rec = run.recovery?.phases.basic;
  assert.ok(rec);
  const historyRef = rec!.attemptsHistory;
  assert.ok(historyRef);
  // 拍快照：当前 history 是第一轮的 3 条；马上 runner 会清空 rec.attempts = []
  // 并开始第二轮的 attempt，我们验证 history 仍是第一轮的快照。
  const historySnapshot = JSON.parse(JSON.stringify(historyRef));
  // 第二轮才刚刚开始，rec.attempts 还应该是空数组（或刚被 push 1 条）。
  // 关键断言：history 数组本身没被第二轮的 attempts 污染。
  await runPhaseWithRecovery(ctx);
  const rec2 = run.recovery?.phases.basic;
  assert.ok(rec2);
  // 第二轮结束后 attemptsHistory 应包含前两轮 6 条
  assert.equal(rec2!.attemptsHistory!.length, MAX_PHASE_ATTEMPTS * 2);
  // historySnapshot 的前 3 条（第一轮）必须保持不变
  assert.deepEqual(rec2!.attemptsHistory!.slice(0, MAX_PHASE_ATTEMPTS), historySnapshot);
});