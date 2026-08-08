import { test, assert, makeRun, makeSpyAdvisor, now, makeExecute, runPhaseWithRecovery, MAX_PHASE_ATTEMPTS } from "./automation-recovery.shared.js";
test("advisor 抛错 → needs_user，finalError 含 AI 诊断失败", async () => {
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
  assert.match(result.finalError || "", /AI 诊断失败/);
  const rec = run.recovery?.phases.basic;
  assert.equal(rec?.state, "needs_user");
  assert.match(rec?.finalError || "", /AI 诊断失败/);
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
  assert.match(result.finalError || "", /AI 诊断失败/);
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
