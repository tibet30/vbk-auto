import test from "node:test";
import assert from "node:assert/strict";
import { preparePhaseRetry, prepareQueuedPhaseResume } from "../../src/main/automation/phase-retry.js";
import type { AutomationRun } from "../../src/shared/contracts.js";

const previous = {
  id: "run-1",
  status: "failed" as const,
  currentPhase: "presentation",
  phases: [
    { phase: "basic", status: "completed" as const },
    { phase: "presentation", status: "failed" as const },
    { phase: "itinerary", status: "pending" as const },
  ],
  logs: [{ at: "2026-08-02T00:00:00.000Z", message: "失败", level: "error" as const }],
};

test("从失败阶段重试时保留之前的成功阶段并重置后续阶段", () => {
  const next = preparePhaseRetry(previous, ["basic", "presentation", "itinerary"], "presentation", "2026-08-02T01:00:00.000Z");
  assert.equal(next.id, previous.id);
  assert.equal(next.status, "running");
  assert.equal(next.currentPhase, "presentation");
  assert.deepEqual(next.phases.map((item) => item.status), ["completed", "pending", "pending"]);
  assert.match(next.logs.at(-1)?.message || "", /presentation/);
});

test("不能重试成功或未知阶段", () => {
  assert.throws(() => preparePhaseRetry(previous, ["basic", "presentation"], "basic"), /不是失败状态/);
  assert.throws(() => preparePhaseRetry(previous, ["basic", "presentation"], "package"), /未知阶段/);
});

test("只有失败的自动录入任务允许阶段重试", () => {
  assert.throws(() => preparePhaseRetry({ ...previous, status: "running" }, ["basic", "presentation"], "presentation"), /只有失败/);
});

// —— 真实 bug 路径：basic 阶段 needs_user 后重试，recovery 记录必须保留 ——
// recovery 里仍记录着上轮的 userInstruction / finalError / attempts，这是
// UI 体现「需要补充什么」的唯一依据。preparePhaseRetry 不能丢掉它，丢掉了
// readiness 就看不到「重试是否修了问题」，UI 重复推老任务的修复提示。
test("preparePhaseRetry 保留 recovery 字段（needs_user 修复路径）", () => {
  const withRecovery = {
    ...previous,
    currentPhase: "basic" as const,
    phases: [
      { phase: "basic", status: "failed" as const },
      { phase: "presentation", status: "pending" as const },
      { phase: "itinerary", status: "pending" as const },
    ],
    recovery: {
      phases: {
        basic: {
          phase: "basic",
          state: "needs_user" as const,
          userInstruction: "请在 VBK 添加联系人「安思科」(ID 1368298) 后重试。",
          finalError: "管家联系人下拉未找到 ID 1368298 / 安思科；可选：李四、王五",
          attempts: [
            {
              attempt: 1,
              error: "管家联系人下拉未找到 ID 1368298 / 安思科；可选：李四、王五",
              at: "2026-08-02T00:00:00.000Z",
              action: "wait_for_user" as const,
              diagnosis: {
                summary: "管家联系人在 VBK 下拉中未找到。",
                rootCause: "账号固定联系人未同步到本账号的 VBK 联系人库。",
                expectedEvidence: "运营在 VBK 联系人库中添加 contactCardId=1368298 后重试。",
              },
            },
          ],
        },
      },
    },
  };

  const next = preparePhaseRetry(withRecovery, ["basic", "presentation", "itinerary"], "basic", "2026-08-02T01:00:00.000Z");
  assert.equal(next.status, "running");
  assert.equal(next.currentPhase, "basic");
  assert.deepEqual(next.phases.map((item) => item.status), ["pending", "pending", "pending"]);
  // recovery 必须保留，里面有上一轮的诊断与 userInstruction
  assert.ok(next.recovery, "recovery 字段必须保留");
  const rec = next.recovery!.phases.basic;
  assert.ok(rec, "recovery.phases.basic 必须保留");
  assert.equal(rec!.state, "needs_user", "recovery 阶段状态保留为 needs_user，runner 会负责重置");
  assert.equal(rec!.userInstruction, "请在 VBK 添加联系人「安思科」(ID 1368298) 后重试。", "userInstruction 保留让 readiness 能展示修复提示");
  assert.match(rec!.finalError || "", /管家联系人下拉未找到/);
  assert.equal(rec!.attempts.length, 1, "上轮 attempts 必须保留供 UI 查看");
});

test("preparePhaseRetry 兼容旧版孤儿恢复遗留的 running 阶段", () => {
  const interrupted: AutomationRun = {
    id: "run-interrupted",
    status: "failed",
    currentPhase: "presentation",
    phases: [
      { phase: "basic", status: "completed" },
      { phase: "presentation", status: "running" },
    ],
    logs: [],
    recovery: {
      phases: {
        presentation: {
          phase: "presentation",
          state: "needs_user",
          attempts: [],
          finalError: "应用重启导致自动录入被中断",
        },
      },
    },
  };

  const next = preparePhaseRetry(interrupted, ["basic", "presentation"], "presentation");
  assert.equal(next.status, "running");
  assert.equal(next.currentPhase, "presentation");
});

test("prepareQueuedPhaseResume：从首个待继续阶段恢复，不重跑已完成阶段", () => {
  const queued: AutomationRun = {
    id: "queued-after-itinerary",
    status: "queued",
    phases: [
      { phase: "basic", status: "completed" },
      { phase: "presentation", status: "completed" },
      { phase: "itinerary", status: "completed" },
      { phase: "package", status: "pending" },
      { phase: "pricingInventory", status: "pending" },
    ],
    logs: [],
  };
  const next = prepareQueuedPhaseResume(queued, queued.phases.map((phase) => phase.phase), "package", "2026-08-31T12:00:00.000Z");
  assert.equal(next.status, "running");
  assert.deepEqual(next.phases.map((phase) => phase.status), ["completed", "completed", "completed", "pending", "pending"]);
  assert.match(next.logs.at(-1)?.message ?? "", /已修复断点继续：package/);
});
