// 智能体失败的用户可见文案：把模型与传输层错误收敛成一句中文，原始技术信息只写诊断日志。
import { isModelInputModerationMessage } from "../../shared/ai-input-moderation.js";
import { logWarn } from "../../shared/log-timestamp.js";

export interface AgentFailureText {
  message: string;
  detail?: string;
}

const CHINESE = /[\u4e00-\u9fff]/u;
const EMPTY_OUTPUT = /no output generated|without a finish chunk|empty (?:response|stream)|未返回可用内容|响应为空/i;
const TIMEOUT = /timeout|timed out|aborterror|aborted|模型响应超时/i;
const CONTEXT_LIMIT = /context[_ -]?length|maximum context|prompt is too long|too many tokens|token limit|reduce the length/i;
const NETWORK = /\b(ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|EPIPE|ETIMEDOUT|UND_ERR_[A-Z_]+)\b|fetch failed|socket hang up|network error|getaddrinfo/i;

function messageOf(error: unknown): string {
  if (typeof error === "string") return error;
  if (!error || typeof error !== "object") return "";
  const message = (error as { message?: unknown }).message;
  return typeof message === "string" ? message.trim() : "";
}

function nameOf(error: unknown): string {
  if (!error || typeof error !== "object") return "";
  const name = (error as { name?: unknown }).name;
  return typeof name === "string" ? name : "";
}

function statusOf(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const record = error as { status?: unknown; statusCode?: unknown };
  const value = record.statusCode ?? record.status;
  return typeof value === "number" ? value : undefined;
}

function isAbort(error: unknown): boolean {
  if (nameOf(error) === "AbortError") return true;
  const reason = error && typeof error === "object" ? (error as { cause?: unknown }).cause : undefined;
  return reason instanceof Error && reason.name === "AbortError";
}

function detailOf(error: unknown, raw: string): string | undefined {
  const detail = error && typeof error === "object" ? (error as { agentDetail?: unknown }).agentDetail : undefined;
  if (typeof detail === "string" && detail.trim()) return detail.trim();
  return raw && !CHINESE.test(raw) ? raw : undefined;
}

function failureText(error: unknown, message: string, raw: string): AgentFailureText {
  const detail = detailOf(error, raw);
  return detail ? { message, detail } : { message };
}

export function describeAgentFailure(error: unknown): AgentFailureText {
  const raw = messageOf(error);
  const name = nameOf(error);
  const status = statusOf(error);
  if (isAbort(error) || TIMEOUT.test(raw)) {
    return failureText(error, "模型响应超时，本次运行已暂停，请重试。", raw);
  }
  if (status === 401 || status === 403 || /unauthorized|invalid api key|incorrect api key|鉴权/i.test(raw)) {
    return failureText(error, "模型服务鉴权失败，请到设置里检查 API Key 是否有效。", raw);
  }
  if (status === 429 || /rate limit|too many requests|限流/i.test(raw)) {
    return failureText(error, "模型服务请求过于频繁，请稍等片刻再重试。", raw);
  }
  if (status !== undefined && status >= 500) {
    return failureText(error, "模型服务暂时不可用，请稍后重试。", raw);
  }
  if (/NoOutputGenerated/i.test(name) || EMPTY_OUTPUT.test(raw)) {
    return failureText(error, "模型这次没有返回任何内容，本次运行已暂停。", raw);
  }
  if (isModelInputModerationMessage(error)) {
    return failureText(error, "请求被模型服务的内容审核拦截，请调整措辞后重试。", raw);
  }
  if (CONTEXT_LIMIT.test(raw)) {
    return failureText(error, "对话上下文超出模型长度限制，请先压缩记录或新建任务再重试。", raw);
  }
  if (NETWORK.test(raw)) {
    return failureText(error, "连不上模型服务，请检查网络或代理设置后重试。", raw);
  }
  if (raw && CHINESE.test(raw)) return { message: raw };
  return failureText(error, "任务执行失败，请重试。", raw);
}

/** 出口统一包装：已是中文的原始错误保持原对象，其余替换成中文文案并保留诊断信息。 */
export function toAgentFailureError(error: unknown): Error {
  const failure = describeAgentFailure(error);
  if (error instanceof Error && error.message === failure.message) return error;
  if (failure.detail) logWarn("[agent] run failed", failure.detail);
  const wrapped = new Error(failure.message, error instanceof Error ? { cause: error } : undefined);
  if (error instanceof Error) wrapped.stack = error.stack;
  const source = error as { name?: unknown; statusCode?: unknown; status?: unknown; code?: unknown } | undefined;
  if (typeof source?.name === "string" && source.name) wrapped.name = source.name;
  if (typeof source?.statusCode === "number") Object.assign(wrapped, { statusCode: source.statusCode });
  if (typeof source?.code === "string") Object.assign(wrapped, { code: source.code });
  return wrapped;
}
