/**
 * 规划子系统 preflight 失败包装：
 *   - 在进入 runPlan 之前（product 存在性检查、API key 解密、adapter 构造、
 *     甚至是 runPlan 自身逃逸的异常），把任意错误转成「状态 = failed」的
 *     持久化生成态 + 一段不会泄露密钥/密文的中文 assistant reply。
 *
 *  这里**不**写 provider / model 字样；分类、reason 文案、reply 都是
 *  provider-neutral。secret 关键字、长 base64 串统一 redact。
 */

import type {
  PlanningGenerationState,
  PlanningStage,
  PlanningStageError,
} from "../../shared/contracts-planning.js";

export interface PreflightFailureResult {
  state: PlanningGenerationState;
  assistantReply: string;
  status: "failed";
}

const BASE64_LIKE_RE = /[A-Za-z0-9+/=]{40,}/g;
// 技术黑名单词：保留「本错误描述」语义的同时，避免把 token / 密钥 / 密文
// 字样写进 UI 可见的 assistant reply 与持久化 lastError.message。
const SENSITIVE_TERM_RE = /\b(ciphertext|api[-_ ]?key|api[-_ ]?token|secret|sk-[a-z0-9]+|bearer)\b/gi;

/**
 * 把任意 unknown error 归类成 provider-neutral 的 code，便于 UI / 日志
 * 区分但又不暴露 transport 细节。
 */
export function classifyPreflightError(error: unknown): "provider_not_configured" | "provider_authentication" | "unknown" {
  const code = (error as { code?: string } | null)?.code;
  if (code === "provider_not_configured" || code === "provider_authentication") return code;
  const message = ((error as { message?: string } | null)?.message ?? "").toLowerCase();
  if (message.includes("decrypt")) return "provider_not_configured";
  if (message.includes("auth")) return "provider_authentication";
  return "unknown";
}

/**
 * 把 error.message 里看起来像 base64 的长串、明显的敏感词（ciphertext /
 * api key / sk- 前缀的 token 等）替换成 [redacted]，避免在持久化 lastError
 * 与 UI notice 中泄露密钥 / 密文 / token。
 */
export function redactSensitiveMessage(message: string): string {
  return message.replace(BASE64_LIKE_RE, "[redacted]").replace(SENSITIVE_TERM_RE, "[redacted]");
}

const REASON_TEXT: Record<string, string> = {
  provider_not_configured: "本机密钥不可用或未配置，无法解密 API Key",
  provider_authentication: "鉴权失败",
  unknown: "规划初始化失败",
};

/**
 * 生成中文 assistant reply；必须含「未完成」，禁止出现「已完成」/「全部完成」/
 * 「成功」。所有面向运营的失败原因走 provider-neutral 中文 reason，不
 * 直接拼 raw error。
 */
export function composePreflightFailureReply(code: string, redactedMessage: string): string {
  const reason = REASON_TEXT[code] ?? REASON_TEXT.unknown;
  // 仅当 redacted 后仍是短且非 [redacted] 时才追加尾巴；否则让 reason 单独承担。
  const tail = redactedMessage && redactedMessage !== "[redacted]" && redactedMessage.length <= 60
    ? `（${redactedMessage}）`
    : "";
  return `方案规划未完成：${reason}${tail}。系统未写入任何产品字段，状态已置为失败；请检查 API Key 设置后点击「重试规划」。`;
}

/**
 * 把一个 pending / running 的 baseState 转成 status="failed" 的新 state。
 *
 *  - currentStage 取自 baseState，缺省退到 "skeleton"；
 *  - completedStages 清空（preflight 阶段什么都没成功）；
 *  - stages 仅保留一条 lastError 记录（provider-neutral code + redacted message）；
 *  - resumeAt 推到当前时刻。
 */
export function buildPreflightFailureState(
  baseState: PlanningGenerationState,
  error: unknown,
): PreflightFailureResult {
  const code = classifyPreflightError(error);
  const rawMessage = (error as { message?: string } | null)?.message ?? "未知错误";
  const redacted = redactSensitiveMessage(rawMessage);
  const nowIso = new Date().toISOString();
  const currentStage: PlanningStage = baseState.currentStage || "skeleton";
  const lastError: PlanningStageError = {
    stage: currentStage,
    attempt: 1,
    code,
    message: redacted,
  };
  const state: PlanningGenerationState = {
    ...baseState,
    currentStage,
    completedStages: [],
    stages: [{
      stage: currentStage,
      accepted: [],
      rejected: [],
      attempts: 1,
      lastError,
      updatedAt: nowIso,
    }],
    status: "failed",
    resumeAt: nowIso,
    lastAssistantReply: undefined,
    lastModuleSummary: undefined,
    lastMissingSummary: undefined,
  };
  return {
    state,
    assistantReply: composePreflightFailureReply(code, redacted),
    status: "failed",
  };
}