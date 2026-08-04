import type {
  AdvisorAction,
  AdvisorOutcome,
  AdvisorRequest,
  AutomationRun,
  PhaseAttempt,
  PhaseRecovery,
  RecoveryState,
} from "../../shared/contracts.js";

export const MAX_PHASE_ATTEMPTS = 3;

const SAFE_ERROR_MAX = 280;
const DEFAULT_USER_INSTRUCTION = "请在 VBK 手动确认后再次保存草稿。";

export interface RecoveryContext {
  /** 当前 automation run，会被 in-place 更新 recovery 字段。 */
  run: AutomationRun;
  /** 当前阶段名。 */
  phase: string;
  /** 已完成阶段列表，用于 advisor 上下文。 */
  completedPhases: string[];
  /** productId 是否存在，用于 reload/reopen 决策。 */
  productIdExists: boolean;
  /** basicInfoSaved，用于 advisor 上下文。 */
  basicInfoSaved: boolean;
  /** 实际执行该阶段的本地 handler；reload/reopen/retry 共用。 */
  execute: () => Promise<unknown>;
  /** advisor 闭包，由 DraftAutomation 注入。 */
  advisor: (req: AdvisorRequest) => Promise<AdvisorOutcome>;
  /** 把 advisor 提议的动作落到本地浏览器；返回新阶段结果。 */
  applyAction: (action: AdvisorAction, attempt: number) => Promise<void>;
  /** log helper；只追加 info/warning/error 字符串。 */
  log: (message: string, level?: "info" | "warning" | "error") => void;
  /** 持久化 AutomationRun 后通知 UI。 */
  persist: () => void;
  /** 用户是否点击了「停止」。由 DraftAutomation 注入，返回 true 时
   *  recovery 循环立刻跳出并以 AutomationCancelledError 抛出，runner
   *  会把 run.status 改为 cancelled 而不是 failed。 */
  shouldCancel?: () => boolean;
  now?: () => Date;
}

export interface RunPhaseOutcome {
  status: "completed" | "needs_user" | "cancelled";
  finalError?: string;
}

// ─────────── helpers ───────────

const ADVISOR_ACTIONS: ReadonlyArray<AdvisorAction> = [
  "retry_same_phase",
  "reload_and_retry_phase",
  "reopen_editor_and_retry_phase",
  "wait_for_user",
];

function isAdvisorAction(value: unknown): value is AdvisorAction {
  return (
    typeof value === "string" &&
    (ADVISOR_ACTIONS as ReadonlyArray<string>).includes(value)
  );
}

interface SafeErrorShape {
  message: string;
}

interface PossiblyStructuredError {
  message?: string;
  toString(): string;
}

/**
 * 把错误对象压成安全字符串：
 * - 优先取 message；
 * - 剥除 vbk 域名、11 位手机号、邮箱、Playwright `page.xxx(...)` 调用、css 选择器；
 * - 截断到 280 字符以避免把堆栈或大对象塞进 advisor 输入。
 */
export function stripSensitive(error: unknown): SafeErrorShape {
  const raw = (() => {
    if (error == null) return "";
    if (typeof error === "string") return error;
    const obj = error as PossiblyStructuredError;
    if (typeof obj.message === "string" && obj.message.length > 0) return obj.message;
    try {
      return obj.toString();
    } catch {
      return "";
    }
  })();
  let safe = raw;
  safe = safe.replace(/https?:\/\/[^\s)]*vbk[^\s)]*/gi, "[vbk-url]");
  safe = safe.replace(/\b1[3-9]\d{9}\b/g, "[phone]");
  safe = safe.replace(/[\w._%+-]+@[\w.-]+\.[A-Za-z]{2,}/g, "[email]");
  safe = safe.replace(/await\s+page\.[a-zA-Z]+/g, "[playwright-call]");
  safe = safe.replace(/page\.[a-zA-Z]+\([^)]*\)/g, "[playwright-call]");
  safe = safe.replace(/select\([^)]*\)/gi, "[selector]");
  if (safe.length > SAFE_ERROR_MAX) {
    safe = `${safe.slice(0, SAFE_ERROR_MAX)}…`;
  }
  return { message: safe };
}

function isoNow(now: () => Date): string {
  return now().toISOString();
}

/**
 * 把已发生的 diagnosis 入栈，并严格裁剪成 4 字段（summary/rootCause/action/expectedEvidence），
 * 防止 userInstruction 或额外字段渗入下一轮 advisor 输入。
 */
function buildDiagnosisHistory(
  attempts: ReadonlyArray<PhaseAttempt>,
): AdvisorRequest["diagnosisHistory"] {
  const out: AdvisorRequest["diagnosisHistory"] = [];
  for (const attempt of attempts) {
    const d = attempt.diagnosis;
    if (!d) continue;
    const action = attempt.action;
    if (!isAdvisorAction(action)) continue;
    out.push({
      summary: d.summary,
      rootCause: d.rootCause,
      action,
      expectedEvidence: d.expectedEvidence,
    });
  }
  return out;
}

interface ArgsLogShape {
  args: unknown[];
  level: "info" | "warning" | "error" | undefined;
}

/**
 * 把任意 log 调用压成单行安全摘要。包含 phase/attempt/action/errorCode，
 * 绝不写入 raw advisor payload 或原始异常对象。
 *
 * 当前 runPhaseWithRecovery 不在内部拼接 log，而是直接转发到 ctx.log；
 * 保留此 helper 以便未来需要写"安全摘要行"的场景（例如 phase summary 行）。
 */
export function summarizeLog(parts: ArgsLogShape): string {
  const segs: string[] = [];
  for (const a of parts.args) {
    if (typeof a === "string") {
      segs.push(a.slice(0, 200));
    } else if (a == null) {
      segs.push(String(a));
    } else {
      try {
        segs.push(JSON.stringify(a).slice(0, 200));
      } catch {
        segs.push("[unserializable]");
      }
    }
  }
  return `[recovery] ${parts.level ?? "info"}: ${segs.join(" ")}`.slice(0, 400);
}

// ─────────── 主入口 ───────────

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
        rec.finalError = "MiniMax 诊断失败";
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
        rec.finalError = "MiniMax 诊断失败：模型返回不在白名单";
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
          rec.finalError = "MiniMax 诊断失败：缺少可执行的用户指令";
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
  rec.finalError = lastError?.message ?? "MiniMax 诊断失败";
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
