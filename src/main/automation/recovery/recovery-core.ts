import type {
  AdvisorAction,
  AdvisorOutcome,
  AdvisorRequest,
  AutomationRun,
  PhaseAttempt,
  PhaseRecovery,
  RecoveryState,
} from "../../../shared/contracts.js";

export const MAX_PHASE_ATTEMPTS = 3;

const SAFE_ERROR_MAX = 280;
export const DEFAULT_USER_INSTRUCTION = "请在 VBK 手动确认后再次保存草稿。";

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

export function isAdvisorAction(value: unknown): value is AdvisorAction {
  return (
    typeof value === "string" &&
    (ADVISOR_ACTIONS as ReadonlyArray<string>).includes(value)
  );
}

export interface SafeErrorShape {
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

export function isoNow(now: () => Date): string {
  return now().toISOString();
}

/**
 * 把已发生的 diagnosis 入栈，并严格裁剪成 4 字段（summary/rootCause/action/expectedEvidence），
 * 防止 userInstruction 或额外字段渗入下一轮 advisor 输入。
 */
export function buildDiagnosisHistory(
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
