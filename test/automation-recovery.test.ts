import test from "node:test";
import assert from "node:assert/strict";
import type {
  AdvisorOutcome,
  AdvisorRequest,
  AutomationRun,
  PhaseRecovery,
} from "../src/shared/contracts.js";
import {
  runPhaseWithRecovery,
  MAX_PHASE_ATTEMPTS,
} from "../src/main/automation/recovery.js";

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
  outcomes: AdvisorOutcome[];
}

function makeSpyAdvisor(outcomes: AdvisorOutcome[] = []): SpyAdvisor {
  const calls: AdvisorRequest[] = [];
  const queue = [...outcomes];
  const fn = async (req: AdvisorRequest): Promise<AdvisorOutcome> => {
    calls.push(req);
    const next = queue.shift();
    if (!next) {
      throw new Error("advisor queue exhausted");
    }
    return next;
  };
  return { fn, calls, outcomes };
}

function now(): () => Date {
  let counter = 0;
  return () => new Date(`2026-08-02T00:00:0${counter++}.000Z`);
}

interface ExecuteOptions {
  failTimes?: number;
  throwOn?: Array<{ message?: string }>;
}

function makeExecute(opts: ExecuteOptions = {}) {
  let calls = 0;
  const list: Array<{ message?: string }> = opts.throwOn ?? [];
  const failTimes = opts.failTimes ?? 0;
  return {
    fn: async () => {
      const idx = calls++;
      if (idx < failTimes) {
        throw new Error(`fail-${idx}`);
      }
      const fail = list[idx];
      if (fail) {
        throw new Error(fail.message ?? `failed-${idx}`);
      }
      return "ok";
    },
    calls: () => calls,
  };
}

function basicCtx(
  overrides: Partial<Parameters<typeof runPhaseWithRecovery>[0]> = {},
): Parameters<typeof runPhaseWithRecovery>[0] {
  const run = makeRun();
  return {
    run,
    phase: "basic",
    completedPhases: [],
    productIdExists: false,
    basicInfoSaved: false,
    execute: async () => undefined,
    advisor: async () => {
      throw new Error("advisor should not be called");
    },
    applyAction: async () => undefined,
    log: () => undefined,
    persist: () => undefined,
    ...overrides,
  };
}

// ───────────────────────── 测试 ─────────────────────────

test("首次成功不调用 advisor", async () => {
  const advisor = makeSpyAdvisor();
  const calls: string[] = [];
  const run: AutomationRun = makeRun();
  const result = await runPhaseWithRecovery({
    run,
    phase: "basic",
    completedPhases: [],
    productIdExists: false,
    basicInfoSaved: false,
    execute: async () => {
      calls.push("exec");
    },
    advisor: advisor.fn,
    applyAction: async () => {
      calls.push("apply");
    },
    log: () => undefined,
    persist: () => undefined,
  });
  assert.equal(result.status, "completed");
  assert.deepEqual(calls, ["exec"]);
  assert.equal(advisor.calls.length, 0);
  assert.equal(run.recovery?.phases.basic?.state, "completed");
});

test("失败一次 → diagnosis → retry_same_phase 重新执行 handler 成功", async () => {
  const advisor = makeSpyAdvisor([
    {
      summary: "基础信息未真正落库。",
      rootCause: "保存按钮回调失败。",
      action: "retry_same_phase",
      expectedEvidence: "tab 可点击。",
    },
  ]);
  let executeCalls = 0;
  const run: AutomationRun = makeRun();
  const result = await runPhaseWithRecovery({
    run,
    phase: "basic",
    completedPhases: [],
    productIdExists: false,
    basicInfoSaved: false,
    execute: async () => {
      executeCalls++;
      if (executeCalls < 2) throw new Error("boom");
    },
    advisor: advisor.fn,
    applyAction: async () => undefined,
    log: () => undefined,
    persist: () => undefined,
    now: now(),
  });
  assert.equal(result.status, "completed");
  assert.equal(advisor.calls.length, 1);
  assert.equal(executeCalls, 2);
  const rec: PhaseRecovery | undefined = run.recovery?.phases.basic;
  assert.ok(rec, "recovery record exists");
  assert.equal(rec!.state, "completed");
  assert.equal(rec!.attempts.length, 1);
  assert.equal(rec!.attempts[0].diagnosis?.rootCause, "保存按钮回调失败。");
  assert.equal(rec!.attempts[0].action, "retry_same_phase");
});

test("reload_and_retry_phase：attempt=1 reload + handler 再执行成功", async () => {
  const advisor = makeSpyAdvisor([
    {
      summary: "页面状态陈旧。",
      rootCause: "DOM 缓存未刷新。",
      action: "reload_and_retry_phase",
      expectedEvidence: "页面重新加载后基本字段 tab 可点。",
    },
  ]);
  const applied: Array<{ action: string; attempt: number }> = [];
  let executeCalls = 0;
  const run: AutomationRun = makeRun();
  const result = await runPhaseWithRecovery({
    run,
    phase: "basic",
    completedPhases: [],
    productIdExists: true,
    basicInfoSaved: false,
    execute: async () => {
      executeCalls++;
      if (executeCalls < 2) throw new Error("reload-me");
    },
    advisor: advisor.fn,
    applyAction: async (action, attempt) => {
      applied.push({ action, attempt });
    },
    log: () => undefined,
    persist: () => undefined,
    now: now(),
  });
  assert.equal(result.status, "completed");
  assert.deepEqual(applied, [{ action: "reload_and_retry_phase", attempt: 1 }]);
  const rec = run.recovery?.phases.basic;
  assert.equal(rec?.state, "completed");
  assert.equal(rec?.attempts[0].action, "reload_and_retry_phase");
});

test("reopen 且 productIdExists=false → 降级为 retry_same_phase", async () => {
  const advisor = makeSpyAdvisor([
    {
      summary: "草稿已丢失。",
      rootCause: "VBK 编辑器未打开。",
      action: "reopen_editor_and_retry_phase",
      expectedEvidence: "编辑页重新出现。",
    },
  ]);
  const applied: Array<{ action: string; attempt: number }> = [];
  let executeCalls = 0;
  const run: AutomationRun = makeRun();
  const result = await runPhaseWithRecovery({
    run,
    phase: "basic",
    completedPhases: [],
    productIdExists: false,
    basicInfoSaved: false,
    execute: async () => {
      executeCalls++;
      if (executeCalls < 2) throw new Error("reopen-me");
    },
    advisor: advisor.fn,
    applyAction: async (action, attempt) => {
      applied.push({ action, attempt });
    },
    log: () => undefined,
    persist: () => undefined,
    now: now(),
  });
  assert.equal(result.status, "completed");
  // advisor 给出 reopen，但 runner 在 productIdExists=false 时降级为 retry_same_phase
  assert.equal(advisor.calls.length, 1);
  assert.deepEqual(applied, [{ action: "retry_same_phase", attempt: 1 }]);
  // runner 写入的 action 也是降级后的
  const rec = run.recovery?.phases.basic;
  assert.equal(rec?.attempts[0].action, "retry_same_phase");
});

test("wait_for_user 立即 stop", async () => {
  const advisor = makeSpyAdvisor([
    {
      summary: "需要用户。",
      rootCause: "缺少关键信息。",
      action: "wait_for_user",
      expectedEvidence: "用户在 VBK 手动补全字段。",
      userInstruction: "请在 VBK 手动补全行程标题后再点保存草稿。",
    },
  ]);
  let executeCalls = 0;
  const applied: string[] = [];
  const run: AutomationRun = makeRun();
  const result = await runPhaseWithRecovery({
    run,
    phase: "basic",
    completedPhases: [],
    productIdExists: true,
    basicInfoSaved: false,
    execute: async () => {
      executeCalls++;
      throw new Error("需要人介入");
    },
    advisor: advisor.fn,
    applyAction: async (action) => {
      applied.push(action);
    },
    log: () => undefined,
    persist: () => undefined,
    now: now(),
  });
  assert.equal(result.status, "needs_user");
  assert.equal(executeCalls, 1);
  assert.deepEqual(applied, []);
  const rec = run.recovery?.phases.basic;
  assert.equal(rec?.state, "needs_user");
  assert.equal(rec?.userInstruction, "请在 VBK 手动补全行程标题后再点保存草稿。");
});

test("advisor 抛错 → needs_user，finalError 含 MiniMax 诊断失败", async () => {
  const advisor = {
    fn: async () => {
      throw new Error("network down");
    },
    calls: [] as AdvisorRequest[],
  };
  let executeCalls = 0;
  const applied: string[] = [];
  const run: AutomationRun = makeRun();
  const result = await runPhaseWithRecovery({
    run,
    phase: "basic",
    completedPhases: [],
    productIdExists: true,
    basicInfoSaved: false,
    execute: async () => {
      executeCalls++;
      throw new Error("handler fail");
    },
    advisor: advisor.fn,
    applyAction: async (action) => {
      applied.push(action);
    },
    log: () => undefined,
    persist: () => undefined,
    now: now(),
  });
  assert.equal(result.status, "needs_user");
  assert.match(result.finalError || "", /MiniMax 诊断失败/);
  const rec = run.recovery?.phases.basic;
  assert.equal(rec?.state, "needs_user");
  assert.match(rec?.finalError || "", /MiniMax 诊断失败/);
  assert.equal(executeCalls, 1);
  assert.deepEqual(applied, []);
});

test("advisor 返回非法 shape（action 不在白名单）→ needs_user", async () => {
  const advisor = makeSpyAdvisor([
    {
      summary: "x",
      rootCause: "y",
      action: "something_else" as unknown as AdvisorOutcome["action"],
      expectedEvidence: "z",
    } as AdvisorOutcome,
  ]);
  let executeCalls = 0;
  const applied: string[] = [];
  const run: AutomationRun = makeRun();
  const result = await runPhaseWithRecovery({
    run,
    phase: "basic",
    completedPhases: [],
    productIdExists: true,
    basicInfoSaved: false,
    execute: async () => {
      executeCalls++;
      throw new Error("fail");
    },
    advisor: advisor.fn,
    applyAction: async (action) => {
      applied.push(action);
    },
    log: () => undefined,
    persist: () => undefined,
    now: now(),
  });
  assert.equal(result.status, "needs_user");
  assert.match(result.finalError || "", /MiniMax 诊断失败/);
  const rec = run.recovery?.phases.basic;
  assert.equal(rec?.state, "needs_user");
  assert.equal(executeCalls, 1);
  assert.deepEqual(applied, []);
});

test("attempt=3 后不再调 advisor、handler 不再被第 4 次执行", async () => {
  // advisor 队列里给前两次失败都备好合法 action，让循环能走到 attempt=3 上限
  const advisor = makeSpyAdvisor([
    {
      summary: "s1",
      rootCause: "r1",
      action: "retry_same_phase",
      expectedEvidence: "e1",
    },
    {
      summary: "s2",
      rootCause: "r2",
      action: "reload_and_retry_phase",
      expectedEvidence: "e2",
    },
  ]);
  let executeCalls = 0;
  const applied: string[] = [];
  const run: AutomationRun = makeRun();
  const result = await runPhaseWithRecovery({
    run,
    phase: "basic",
    completedPhases: [],
    productIdExists: true,
    basicInfoSaved: false,
    execute: async () => {
      executeCalls++;
      throw new Error("always fails");
    },
    advisor: advisor.fn,
    applyAction: async (action) => {
      applied.push(action);
    },
    log: () => undefined,
    persist: () => undefined,
    now: now(),
  });
  assert.equal(result.status, "needs_user");
  // handler 仅被调用 3 次
  assert.equal(executeCalls, MAX_PHASE_ATTEMPTS);
  // 第 3 次失败后不再调用 advisor 也不再调用 applyAction
  assert.equal(advisor.calls.length, 2, "仅前两次失败调用 advisor");
  assert.equal(applied.length, 2, "仅前两次失败调用 applyAction");
  const rec = run.recovery?.phases.basic;
  assert.equal(rec?.state, "needs_user");
  assert.equal(rec?.attempts.length, MAX_PHASE_ATTEMPTS);
});

// ─────────── 用户要求扩展的 3 条断言 ───────────

test("扩展: handler 调用次数最多 3 次（含首次），恰好 3 次失败时 attempts.length=3", async () => {
  // advisor 必须每次返回合法 action，让循环走到 attempt=3 上限
  const advisor = makeSpyAdvisor([
    {
      summary: "s1",
      rootCause: "r1",
      action: "retry_same_phase",
      expectedEvidence: "e1",
    },
    {
      summary: "s2",
      rootCause: "r2",
      action: "retry_same_phase",
      expectedEvidence: "e2",
    },
  ]);
  const exec = makeExecute({ failTimes: MAX_PHASE_ATTEMPTS });
  const run: AutomationRun = makeRun();
  const result = await runPhaseWithRecovery({
    run,
    phase: "basic",
    completedPhases: [],
    productIdExists: true,
    basicInfoSaved: false,
    execute: exec.fn,
    advisor: advisor.fn,
    applyAction: async () => undefined,
    log: () => undefined,
    persist: () => undefined,
    now: now(),
  });
  assert.equal(result.status, "needs_user");
  assert.equal(exec.calls(), MAX_PHASE_ATTEMPTS, "handler 调用恰好 3 次");
  const rec = run.recovery?.phases.basic;
  assert.equal(rec?.attempts.length, MAX_PHASE_ATTEMPTS);
  // attempts 序号 1..3
  assert.deepEqual(rec?.attempts.map((a) => a.attempt), [1, 2, 3]);
});

test("扩展: diagnosisHistory 仅含 summary/rootCause/action/expectedEvidence 四个字段", async () => {
  const advisor = makeSpyAdvisor([
    {
      summary: "页面状态陈旧。",
      rootCause: "DOM 缓存未刷新。",
      action: "retry_same_phase",
      expectedEvidence: "tab 可点击。",
      userInstruction: "不应进入 diagnosisHistory",
    },
    {
      summary: "再次失败。",
      rootCause: "仍是 DOM 问题。",
      action: "reload_and_retry_phase",
      expectedEvidence: "页面刷新。",
      userInstruction: "也不应进入",
    },
  ]);
  let executeCalls = 0;
  const run: AutomationRun = makeRun();
  // 故意造一个上一次的诊断历史，混入额外字段
  const previousExtra = { junk: "leak", apiKey: "sk-LEAK" };
  await runPhaseWithRecovery({
    run,
    phase: "basic",
    completedPhases: [],
    productIdExists: true,
    basicInfoSaved: false,
    execute: async () => {
      executeCalls++;
      if (executeCalls < 3) throw new Error("retry me");
    },
    advisor: async (req: AdvisorRequest): Promise<AdvisorOutcome> => {
      // 验证传进来的 diagnosisHistory 已经剥离了额外字段
      for (const item of req.diagnosisHistory) {
        assert.deepEqual(
          Object.keys(item).sort(),
          ["action", "expectedEvidence", "rootCause", "summary"],
        );
      }
      return advisor.fn(req);
    },
    applyAction: async () => undefined,
    log: () => undefined,
    persist: () => undefined,
    now: now(),
  });
  assert.equal(executeCalls, 3);
  assert.equal(advisor.calls.length, 2);
  // 第一次的 diagnosisHistory 是空
  assert.deepEqual(advisor.calls[0].diagnosisHistory, []);
  // 第二次的 diagnosisHistory 只有 4 个字段
  assert.equal(advisor.calls[1].diagnosisHistory.length, 1);
  assert.deepEqual(
    Object.keys(advisor.calls[1].diagnosisHistory[0]).sort(),
    ["action", "expectedEvidence", "rootCause", "summary"],
  );
  // 防止 prior 引用混淆
  void previousExtra;
});

test("扩展: 错误脱敏（剥掉 vbk 域名 / 11 位手机号 / 邮箱 / page.* 调用）", async () => {
  const advisor = makeSpyAdvisor([
    {
      summary: "v",
      rootCause: "r",
      action: "retry_same_phase",
      expectedEvidence: "e",
    },
  ]);
  let executeCalls = 0;
  const run: AutomationRun = makeRun();
  await runPhaseWithRecovery({
    run,
    phase: "basic",
    completedPhases: [],
    productIdExists: true,
    basicInfoSaved: false,
    execute: async () => {
      executeCalls++;
      if (executeCalls < 2) {
        const err = new Error(
          "在 https://www.vbk.example.com/page 上 await page.click('#submit') 失败，电话 13812345678，邮箱 test@example.com",
        );
        throw err;
      }
    },
    advisor: (req) => {
      // 传给 advisor 的错误文本必须不再含敏感片段
      assert.doesNotMatch(req.error, /vbk\.example\.com/i);
      assert.doesNotMatch(req.error, /13812345678/);
      assert.doesNotMatch(req.error, /test@example\.com/);
      assert.doesNotMatch(req.error, /page\.click/);
      return advisor.fn(req);
    },
    applyAction: async () => undefined,
    log: () => undefined,
    persist: () => undefined,
    now: now(),
  });
  const rec = run.recovery?.phases.basic;
  // attempts[0].error 也应该脱敏
  assert.doesNotMatch(rec?.attempts[0].error || "", /vbk\.example\.com/i);
  assert.doesNotMatch(rec?.attempts[0].error || "", /13812345678/);
  assert.doesNotMatch(rec?.attempts[0].error || "", /test@example\.com/);
  assert.doesNotMatch(rec?.attempts[0].error || "", /page\.click/);
});
