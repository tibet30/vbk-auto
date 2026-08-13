/**
 * Provider-specific transport 适配层（与具体 adapter 解耦）。
 *
 *  本文件只负责「把 provider 名字 → OpenAI Chat Completions 请求需要的
 *  transport 形态」以及「把 OpenAI SDK 抛出的 transport 错误归一化为
 *  orchestrator 能识别的 PlannerError code」。adapter（见
 *  openai-compatible-adapter.ts）持有调用本文件的入口，但自身不再分支依赖
 *  provider 字样；prompt / schema / validator / orchestrator 也都不再依赖。
 */

import OpenAI, {
  APIConnectionError,
  APIConnectionTimeoutError,
  AuthenticationError,
  RateLimitError,
} from "openai";
import { PlannerError } from "../../../shared/contracts-planning.js";

/**
 * 一次 chat.completions.create 请求体的内部表达。
 *
 *  - 静态类型：取 OpenAI SDK 第一个 create 重载的 body 形参（non-streaming），
 *    并在末尾打开一个 `Record<string, unknown>` 索引签名，让 MiniMax 专有
 *    字段（thinking / reasoning_split / service_tier）能通过类型检查而无需
 *    `as never` 这种把整段表达式擦成 any 的逃生口。
 *  - 运行时：调用方负责拼装正确的 MiniMax / DeepSeek 差异；adapter 自身不分支。
 */
export type ChatCompletionBody = OpenAI.Chat.ChatCompletionCreateParamsNonStreaming
  & Record<string, unknown>;

/** MiniMax 的规划请求必须关闭深度思考，否则简单结构化阶段也可能长时间占用连接。 */
export function planningTransportOptions(provider: "minimax" | "deepseek") {
  if (provider === "deepseek") return { provider };
  return {
    provider,
    extraParams: {
      thinking: { type: "disabled" },
      reasoning_split: true,
      service_tier: process.env.MINIMAX_SERVICE_TIER === "priority" ? "priority" : "standard",
    },
  };
}

/** 把 OpenAI SDK 的稳定错误类型映射到 orchestrator 能识别的 provider-neutral code。
 *
 *  每个分支在 `details` 里保留原 error 的可读信息（status / code / message），
 *  供 UI 在「重试」按钮旁打出原服务错误码——这是产品侧的可观测性需求。 */
export function normaliseTransportError(error: unknown): PlannerError {
  if (error instanceof PlannerError) return error;
  const causeMessage = error instanceof Error && error.message ? error.message : String(error);
  if (error instanceof AuthenticationError) {
    return new PlannerError(
      "provider_authentication",
      "AI 服务鉴权失败，请检查当前 API Key。",
      describeCause(error, causeMessage),
    );
  }
  if (error instanceof RateLimitError) {
    return new PlannerError(
      "provider_rate_limit",
      "AI 服务请求频率受限，请稍后重试。",
      describeCause(error, causeMessage),
    );
  }
  if (error instanceof APIConnectionTimeoutError
    || (error instanceof Error && (error.name === "AbortError" || /timed?\s*out|timeout/i.test(error.message)))) {
    return new PlannerError(
      "provider_timeout",
      "AI 规划响应超时，请重试。",
      describeCause(error, causeMessage),
    );
  }
  if (error instanceof APIConnectionError) {
    return new PlannerError(
      "provider_connection",
      "无法连接 AI 服务，请检查网络后重试。",
      describeCause(error, causeMessage),
    );
  }
  const status = typeof error === "object" && error !== null && "status" in error
    ? Number((error as { status?: unknown }).status) : 0;
  if (status === 401 || status === 403) {
    return new PlannerError(
      "provider_authentication",
      "AI 服务鉴权失败，请检查当前 API Key。",
      `status=${status} ${causeMessage}`,
    );
  }
  if (status === 429) {
    return new PlannerError(
      "provider_rate_limit",
      "AI 服务请求频率受限，请稍后重试。",
      `status=${status} ${causeMessage}`,
    );
  }
  if (status >= 500) {
    return new PlannerError(
      "provider_connection",
      `AI 服务暂时不可用（HTTP ${status}）。`,
      `status=${status} ${causeMessage}`,
    );
  }
  return new PlannerError(
    "unknown",
    causeMessage || "AI 服务返回未知错误。",
    typeof error === "object" && error !== null ? describeRawError(error) : undefined,
  );
}

/**
 * 拼出 OpenAI SDK 错误的最小可读表示：status + SDK 自带的 code + message。
 * 缺省字段一律省略，避免 details 里出现 undefined / 空键。
 */
function describeCause(error: unknown, fallbackMessage: string): string {
  const parts: string[] = [];
  if (error && typeof error === "object") {
    const status = (error as { status?: unknown }).status;
    if (typeof status === "number") parts.push(`status=${status}`);
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string") parts.push(`code=${code}`);
  }
  parts.push(fallbackMessage);
  return parts.join(" ");
}

function describeRawError(error: object): string {
  try {
    const json = JSON.stringify(error);
    return json && json.length > 0 && json !== "{}" ? json : "";
  } catch {
    return "";
  }
}