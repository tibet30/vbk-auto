import test from "node:test";
import assert from "node:assert/strict";
import type { AutomationRun } from "../../src/shared/contracts.js";
import { prepareSinglePhaseRetry } from "../../src/main/automation/phase-retry.js";

// ───────────────────────── helpers ─────────────────────────

function makePrevious(status: AutomationRun["status"]): AutomationRun {
  return {
    id: "run-1",
    status,
    phases: [
      { phase: "basic", status: "completed" },
      { phase: "presentation", status: "completed" },
      { phase: "itinerary", status: "completed" },
      { phase: "package", status: "completed" },
      { phase: "preflight", status: "pending" },
    ],
    logs: [{ at: "2026-08-02T00:00:00.000Z", message: "上一轮", level: "info" }],
    recovery: { phases: {} },
  };
}

const ALL_PHASES = ["basic", "presentation", "itinerary", "package", "preflight"];

// ───────────────────────── 测试 ─────────────────────────

test("succeeded run 上对中间阶段重新执行：只重置目标阶段，后续阶段保留", () => {
  const previous = makePrevious("succeeded");
  const next = prepareSinglePhaseRetry(previous, ALL_PHASES, "itinerary", "2026-08-02T01:00:00.000Z");
  // run 临时变成 running（让 UI 看到正在重跑），后续由 DraftAutomation 恢复。
  assert.equal(next.status, "running");
  assert.equal(next.currentPhase, "itinerary");
  // 目标阶段 itinerary 回到 pending；其他阶段原封不动 —— 这是与
  // preparePhaseRetry 的关键差异点。
  assert.deepEqual(next.phases.map((p) => p.status), ["completed", "completed", "pending", "completed", "pending"]);
  // 写入 recovery[itinerary]，让 recovery 循环视作新进入的阶段。
  assert.ok(next.recovery?.phases.itinerary);
  assert.equal(next.recovery!.phases.itinerary.state, "running");
  assert.equal(next.recovery!.phases.itinerary.attempts.length, 0);
  // 末尾日志说明是「重新执行」（不是「从失败阶段重试」）
  assert.match(next.logs.at(-1)?.message || "", /正在重新执行阶段：itinerary/);
});

test("cancelled run 上对任意阶段重新执行：允许；run 临时 running、目标阶段 pending", () => {
  const previous = makePrevious("cancelled");
  const next = prepareSinglePhaseRetry(previous, ALL_PHASES, "basic", "2026-08-02T01:00:00.000Z");
  assert.equal(next.status, "running");
  assert.equal(next.currentPhase, "basic");
  assert.deepEqual(next.phases.map((p) => p.status), ["pending", "completed", "completed", "completed", "pending"]);
});

test("目标阶段不需要是 failed 状态：completed / pending / running 都可以", () => {
  // completed
  const succ = makePrevious("succeeded");
  assert.doesNotThrow(() => prepareSinglePhaseRetry(succ, ALL_PHASES, "itinerary"));
  // pending (preflight 是 pending)
  assert.doesNotThrow(() => prepareSinglePhaseRetry(succ, ALL_PHASES, "preflight"));
});

test("running run 不允许重新执行：抛错阻断", () => {
  const previous = makePrevious("running");
  assert.throws(() => prepareSinglePhaseRetry(previous, ALL_PHASES, "itinerary"), /正在进行中/);
});

test("未知阶段抛错", () => {
  const previous = makePrevious("succeeded");
  assert.throws(() => prepareSinglePhaseRetry(previous, ALL_PHASES, "packageXYZ"), /未知阶段/);
});

test("不在当前产品的阶段列表里抛错（防止误传其它产品的阶段名）", () => {
  const previous = makePrevious("succeeded");
  // basic 在 ALL_PHASES 里，但故意传一个不在产品 phases 里的名称
  assert.throws(() => prepareSinglePhaseRetry(previous, ["presentation", "itinerary"], "basic"), /未知阶段/);
});

test("失败的 run 也可以单阶段重新执行：与 retryPhase 共享入口，但不动后续已完成阶段", () => {
  // failed run 通常不会所有阶段都失败；这里构造一个 basic 完成、presentation 失败。
  const previous: AutomationRun = {
    id: "run-fail",
    status: "failed",
    currentPhase: "presentation",
    phases: [
      { phase: "basic", status: "completed" },
      { phase: "presentation", status: "failed" },
      { phase: "itinerary", status: "pending" },
    ],
    logs: [],
    recovery: { phases: { presentation: { phase: "presentation", state: "needs_user", attempts: [] } } },
  };
  // 单阶段重跑 presentation —— preparePhaseRetry 会要求 phase 是 failed 才让重试；
  // prepareSinglePhaseRetry 仅要求它存在且 run 不是 running 即可。
  const next = prepareSinglePhaseRetry(previous, ["basic", "presentation", "itinerary"], "presentation", "2026-08-02T01:00:00.000Z");
  assert.equal(next.status, "running");
  // 只有 presentation 被重置；itinerary 保留 pending（与 preparePhaseRetry 不同）。
  assert.deepEqual(next.phases.map((p) => p.status), ["completed", "pending", "pending"]);
  // 之前 failed 的 presentation 的 recovery 记录被清空 —— runOnePhase 会重新进入。
  assert.equal(next.recovery!.phases.presentation.state, "running");
  assert.equal(next.recovery!.phases.presentation.attempts.length, 0);
});

test("保留并继承之前的 recovery 记录：其他阶段的 recovery 不被擦除", () => {
  const previous: AutomationRun = {
    ...makePrevious("succeeded"),
    recovery: {
      phases: {
        basic: { phase: "basic", state: "completed", attempts: [{ attempt: 1, error: "ok", at: "2026-08-01T00:00:00.000Z" }] },
        presentation: { phase: "presentation", state: "completed", attempts: [] },
      },
    },
  };
  const next = prepareSinglePhaseRetry(previous, ALL_PHASES, "itinerary", "2026-08-02T01:00:00.000Z");
  // 之前的 recovery 必须保留
  assert.ok(next.recovery?.phases.basic);
  assert.equal(next.recovery!.phases.basic.state, "completed");
  // 目标的 recovery 被重置为 running + 空 attempts
  assert.equal(next.recovery!.phases.itinerary.state, "running");
  assert.equal(next.recovery!.phases.itinerary.attempts.length, 0);
  // presentation 的 recovery 仍在
  assert.ok(next.recovery?.phases.presentation);
});

test("screenshot 字段被清空：单阶段重跑后由 runOnePhase 重新生成", () => {
  const previous: AutomationRun = { ...makePrevious("succeeded"), screenshot: "data:image/png;base64,xxx" };
  const next = prepareSinglePhaseRetry(previous, ALL_PHASES, "itinerary");
  assert.equal(next.screenshot, undefined);
});