import type { AutomationRun, PhaseAttempt } from "../../../src/shared/contracts.js";
import { resolveRunStatusAfterSinglePhaseSuccess } from "../../../src/main/automation/automation.main/automation.main.run-one-state.js";

export const ALL_PHASES = ["basic", "presentation", "itinerary", "package"] as const;

/** 构造一个「presentation 上一次失败、其它阶段混合状态」的 AutomationRun。 */
export function makePreviousFailedRun(): AutomationRun {
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
export async function successfulExecute(): Promise<unknown> {
  return "ok";
}

/** 模拟 runOnePhase 的成功分支：恢复 run.status + run.currentPhase */
export function applyCompletedOutcome(run: AutomationRun, originalRunStatus: AutomationRun["status"]): void {
  run.status = resolveRunStatusAfterSinglePhaseSuccess(run, originalRunStatus);
  run.currentPhase = undefined;
}

