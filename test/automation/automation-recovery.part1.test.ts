import { test, assert, makeRun, makeSpyAdvisor, now, runPhaseWithRecovery } from "./automation-recovery.shared.js";
import { NonAdvisableAutomationError } from "../../src/main/automation/automation.main/automation.main.errors.js";
import { refreshPhasePageBeforeRetry } from "../../src/main/automation/automation.main/automation.main.retry-navigation.js";
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

test("结果校验成功后统一更新阶段完成态并持久化", async () => {
  const run: AutomationRun = {
    ...makeRun(),
    phases: [{ phase: "basic", status: "running" }],
  };
  const snapshots: string[] = [];

  const result = await runPhaseWithRecovery({
    run,
    phase: "basic",
    completedPhases: [],
    productIdExists: true,
    basicInfoSaved: false,
    execute: async () => undefined,
    advisor: async () => { throw new Error("不应调用 advisor"); },
    applyAction: async () => undefined,
    log: () => undefined,
    persist: () => snapshots.push(run.phases[0].status),
  });

  assert.equal(result.status, "completed");
  assert.equal(run.phases[0].status, "completed");
  assert.ok(snapshots.includes("completed"));
});

test("确定性系统错误直接上抛，不调用 advisor 或执行重试动作", async () => {
  const advisor = makeSpyAdvisor();
  const run: AutomationRun = makeRun();
  let executeCalls = 0;
  let applyCalls = 0;
  await assert.rejects(
    runPhaseWithRecovery({
      run,
      phase: "basic",
      completedPhases: [],
      productIdExists: true,
      basicInfoSaved: false,
      execute: async () => {
        executeCalls += 1;
        throw new NonAdvisableAutomationError("线上 400 电话下拉未找到「0609240」；可选：无");
      },
      advisor: advisor.fn,
      applyAction: async () => { applyCalls += 1; },
      log: () => undefined,
      persist: () => undefined,
    }),
    (error: unknown) => error instanceof NonAdvisableAutomationError
      && error.message.includes("0609240"),
  );
  assert.equal(executeCalls, 1);
  assert.equal(advisor.calls.length, 0);
  assert.equal(applyCalls, 0);
  assert.equal(run.recovery?.phases.basic?.state, "needs_user");
  assert.match(run.recovery?.phases.basic?.finalError ?? "", /0609240/);
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

test("retry 前先刷新当前 phase 页面，再重新执行 handler", async () => {
  const advisor = makeSpyAdvisor([
    {
      summary: "产品图文页面状态陈旧。",
      rootCause: "封面绑定后的页面状态未同步。",
      action: "retry_same_phase",
      expectedEvidence: "刷新产品图文页后重新绑定封面。",
    },
  ]);
  const order: string[] = [];
  let executeCalls = 0;
  const run: AutomationRun = makeRun();
  const result = await runPhaseWithRecovery({
    run,
    phase: "presentation",
    completedPhases: ["basic"],
    productIdExists: true,
    basicInfoSaved: true,
    execute: async () => {
      executeCalls += 1;
      order.push(`execute-${executeCalls}`);
      if (executeCalls < 2) throw new Error("图片未设置好");
    },
    advisor: advisor.fn,
    applyAction: async (action, attempt) => {
      order.push(`refresh-${action}-${attempt}`);
    },
    log: () => undefined,
    persist: () => undefined,
    now: now(),
  });
  assert.equal(result.status, "completed");
  assert.deepEqual(order, [
    "execute-1",
    "refresh-retry_same_phase-1",
    "execute-2",
  ]);
});

test("API-only presentation 重试不再导航产品图文页", async () => {
  const gotos: string[] = [];
  const page = {
    goto: async (url: string) => { gotos.push(url); },
    waitForLoadState: async () => undefined,
  };
  await refreshPhasePageBeforeRetry({
    page,
    productId: "77025968",
    phase: "presentation",
    action: "retry_same_phase",
    attempt: 1,
    log: () => undefined,
  });
  assert.equal(gotos.length, 0);
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
