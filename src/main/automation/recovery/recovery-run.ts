import {
  DEFAULT_USER_INSTRUCTION,
  MAX_PHASE_ATTEMPTS,
  RecoveryContext,
  RunPhaseOutcome,
  SafeErrorShape,
  buildDiagnosisHistory,
  isAdvisorAction,
  isoNow,
  stripSensitive,
} from "./recovery-core.js";
import type { PhaseRecovery } from "../../../shared/contracts.js";
import type {
  AdvisorAction,
  AdvisorOutcome,
  AdvisorRequest,
  PhaseAttempt,
} from "../../../shared/contracts.js";

export async function runPhaseWithRecovery(
  ctx: RecoveryContext,
): Promise<RunPhaseOutcome> {
  const now = ctx.now ?? (() => new Date());
  const persist = () => {
    try {
      ctx.persist();
    } catch {
      // 持久化失败不影响 runner 主流程
    }
  };

  ctx.run.recovery ??= { phases: {} };
  const recoveryByPhase = ctx.run.recovery.phases;
  let rec: PhaseRecovery = recoveryByPhase[ctx.phase] ?? {
    phase: ctx.phase,
    state: "running",
    attempts: [],
  };
  recoveryByPhase[ctx.phase] = rec;

  // 同一 runner 第二次进入 phase时，把旧 attempts 归档到 attemptsHistory 让 UI
  // 仍能看见上轮的诊断记录；再清空 rec.attempts / userInstruction / finalError
  // 准备一轮重试。当 rec.state=completed 时不归档（不要把成功的 attempt
  // 当作“上一轮需要重跑”）。
  const wasUnfinished = rec.state !== "completed" && rec.attempts.length > 0;
  if (wasUnfinished) {
    const history = [...(rec.attemptsHistory ?? []), ...rec.attempts];
    if (history.length) rec.attemptsHistory = history;
  }
  rec = {
    phase: ctx.phase,
    state: "running",
    attempts: rec.attempts,
    ...(rec.attemptsHistory ? { attemptsHistory: rec.attemptsHistory } : {}),
  };
  recoveryByPhase[ctx.phase] = rec;
  rec.state = "running";
  rec.attempts = [];
  rec.userInstruction = undefined;
  rec.finalError = undefined;
  persist();

  let lastError: SafeErrorShape | undefined;

  for (let attempt = 1; attempt <= MAX_PHASE_ATTEMPTS; attempt++) {
    rec.state = "running";
    persist();

    // 用户中止检查：放在 attempt 顶部而不是 handler 内部 —— 当前 handler
    // 已经在跑就让它自然结束，避免掐断 Playwright 调用让页面留下半成品 UI。
    // 下一次 attempt 不再启动。status 走 cancelled，由 runner 负责更新
    // run.status / project.status。
    if (ctx.shouldCancel?.()) {
      rec.state = "needs_user";
      rec.finalError = "用户中止了自动录入";
      if (!rec.userInstruction) rec.userInstruction = "已停止当前自动录入，请在 VBK 核查当前页面后重新保存草稿。";
      ctx.log(`phase=${ctx.phase} cancelled before attempt=${attempt}`, "warning");
      persist();
      return { status: "cancelled", finalError: rec.finalError };
    }

    try {
      await ctx.execute();
      // handler 跑完了但用户可能在期间点了停止；这种情况下「阶段已成功」
      // 不重要，立刻退出，避免再启下一阶段。保留 attempts 为空 ——
      // 不诊断一个成功的阶段。
      if (ctx.shouldCancel?.()) {
        rec.state = "needs_user";
        rec.finalError = "用户中止了自动录入";
        if (!rec.userInstruction) rec.userInstruction = "已停止当前自动录入，请在 VBK 核查当前页面后重新保存草稿。";
        ctx.log(`phase=${ctx.phase} cancelled after attempt=${attempt}`, "warning");
        persist();
        return { status: "cancelled", finalError: rec.finalError };
      }
      rec.state = "completed";
      ctx.log(`phase=${ctx.phase} attempt=${attempt} completed`, "info");
      persist();
      return { status: "completed" };
    } catch (err) {
      lastError = stripSensitive(err);
      const errorMessage = lastError.message;

      const attemptRecord: PhaseAttempt = {
        attempt,
        error: errorMessage,
        at: isoNow(now),
      };
      rec.attempts.push(attemptRecord);
      ctx.log(`phase=${ctx.phase} attempt=${attempt} failed`, "warning");
      persist();

      // 达到上限后：不再 advisor、不再 applyAction，直接 needs_user
      if (attempt >= MAX_PHASE_ATTEMPTS) {
        break;
      }

      // 调 advisor
      rec.state = "advising";
      persist();

      const advisorReq: AdvisorRequest = {
        phase: ctx.phase,
        attempt,
        error: errorMessage,
        productIdExists: ctx.productIdExists,
        basicInfoSaved: ctx.basicInfoSaved,
        completedPhases: ctx.completedPhases,
        diagnosisHistory: buildDiagnosisHistory(rec.attempts),
      };

      let outcome: AdvisorOutcome;
      try {
        outcome = await ctx.advisor(advisorReq);
      } catch (advisorErr) {
        ctx.log(
          `phase=${ctx.phase} attempt=${attempt} advisorError code=${
            (advisorErr as { code?: string }).code ?? "advisor_failed"
          }`,
          "error",
        );
        // advisor 抛错 → 等价 wait_for_user
        rec.state = "needs_user";
        rec.finalError = "AI 诊断失败";
        if (!rec.userInstruction) {
          rec.userInstruction = DEFAULT_USER_INSTRUCTION;
        }
        persist();
        return { status: "needs_user", finalError: rec.finalError };
      }

      // 严格校验 outcome 形状
      const safeAction = outcome && isAdvisorAction(outcome.action)
        ? outcome.action
        : null;
      const isValidShape =
        safeAction !== null &&
        typeof outcome.summary === "string" &&
        outcome.summary.length > 0 &&
        typeof outcome.rootCause === "string" &&
        outcome.rootCause.length > 0 &&
        typeof outcome.expectedEvidence === "string" &&
        outcome.expectedEvidence.length > 0;

      if (!isValidShape) {
        ctx.log(
          `phase=${ctx.phase} attempt=${attempt} advisorInvalidShape`,
          "error",
        );
        rec.state = "needs_user";
        rec.finalError = "AI 诊断失败：模型返回不在白名单";
        if (!rec.userInstruction) {
          rec.userInstruction = DEFAULT_USER_INSTRUCTION;
        }
        persist();
        return { status: "needs_user", finalError: rec.finalError };
      }

      // wait_for_user：要求 userInstruction 非空
      if (safeAction === "wait_for_user") {
        if (
          !outcome.userInstruction ||
          typeof outcome.userInstruction !== "string" ||
          outcome.userInstruction.length === 0
        ) {
          ctx.log(
            `phase=${ctx.phase} attempt=${attempt} advisorMissingUserInstruction`,
            "error",
          );
          rec.state = "needs_user";
          rec.finalError = "AI 诊断失败：缺少可执行的用户指令";
          if (!rec.userInstruction) {
            rec.userInstruction = DEFAULT_USER_INSTRUCTION;
          }
          persist();
          return { status: "needs_user", finalError: rec.finalError };
        }
        const last = rec.attempts[rec.attempts.length - 1];
        if (last) {
          last.diagnosis = {
            summary: outcome.summary,
            rootCause: outcome.rootCause,
            expectedEvidence: outcome.expectedEvidence,
          };
          last.action = "wait_for_user";
        }
        rec.state = "needs_user";
        rec.userInstruction = outcome.userInstruction;
        rec.finalError = errorMessage;
        ctx.log(`phase=${ctx.phase} attempt=${attempt} waitForUser`, "warning");
        persist();
        return { status: "needs_user", finalError: rec.finalError };
      }

      // 其他三类的执行：写入本次 diagnosis + action（带降级）
      let action: AdvisorAction = safeAction;
      if (action === "reopen_editor_and_retry_phase" && !ctx.productIdExists) {
        action = "retry_same_phase";
      }

      const last2 = rec.attempts[rec.attempts.length - 1];
      if (last2) {
        last2.diagnosis = {
          summary: outcome.summary,
          rootCause: outcome.rootCause,
          expectedEvidence: outcome.expectedEvidence,
        };
        last2.action = action;
      }
      rec.state = "retrying";
      persist();

      ctx.log(
        `phase=${ctx.phase} attempt=${attempt} retrying action=${action}`,
        "info",
      );

      try {
        await ctx.applyAction(action, attempt);
      } catch (applyErr) {
        // applyAction 抛错 → 视为本轮尝试终结：进入下一轮 attempt（不是新错，而是这一轮被吞掉）
        ctx.log(
          `phase=${ctx.phase} attempt=${attempt} applyFailed action=${action}`,
          "error",
        );
        // 不增加 attempt：applyAction 是 advisor 提议的副作用；它失败算本 attempt 失败。
        // 把这条错误作为下一轮的初始失败：写一条合成 attempt 让 advisor 知道
        const synthMessage = `apply_action_failed: ${stripSensitive(applyErr).message}`;
        // 不写入 attempts（attempts 仅记录 handler 失败）；但喂给下一次 advisor
        lastError = { message: synthMessage };
      }
    }
  }

  // 退出主循环：attempts 已达 MAX_PHASE_ATTEMPTS 且仍失败
  rec.state = "needs_user";
  rec.finalError = lastError?.message ?? "AI 诊断失败";
  if (!rec.userInstruction) {
    rec.userInstruction = DEFAULT_USER_INSTRUCTION;
  }
  ctx.log(
    `phase=${ctx.phase} reached max attempts ${MAX_PHASE_ATTEMPTS}, blocked`,
    "error",
  );
  persist();
  return { status: "needs_user", finalError: rec.finalError };
}
