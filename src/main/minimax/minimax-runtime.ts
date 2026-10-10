import OpenAI, {
  APIConnectionError,
  APIConnectionTimeoutError,
  AuthenticationError,
  RateLimitError,
} from "openai";
import type { AiUsageEvent, AiUsageSource } from "../../shared/contracts.js";
import { toAiUsageEvent } from "../ai/completion-usage.js";
import { MiniMaxServiceError, responseTool } from "./minimax-constants.js";

export interface MiniMaxConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  provider?: string;
}

export function isDeepSeek(config: MiniMaxConfig): boolean {
  return config.provider === "deepseek";
}

export function providerLabel(config: MiniMaxConfig): string {
  return isDeepSeek(config) ? "Evolink" : "MiniMax";
}

export function replyTimeout(): number {
  const parsed = Number(process.env.MINIMAX_REPLY_TIMEOUT_MS);
  return Number.isFinite(parsed) && parsed >= 30_000 ? parsed : 90_000;
}

export function disambiguationTimeout(): number {
  const parsed = Number(process.env.MINIMAX_DISAMBIGUATION_TIMEOUT_MS);
  return Number.isFinite(parsed) && parsed >= 1_000 && parsed <= 15_000 ? parsed : 8_000;
}

export function miniMaxServiceTier(): "priority" | "standard" {
  return process.env.MINIMAX_SERVICE_TIER === "priority" ? "priority" : "standard";
}

export function createMiniMaxClient(config: MiniMaxConfig, timeout: number): OpenAI {
  return new OpenAI({ apiKey: config.apiKey, baseURL: config.baseUrl, timeout, maxRetries: 0 });
}

export function emitMiniMaxUsage(
  config: MiniMaxConfig,
  usage: { runId?: string; attempt?: number; onEvent?: (event: AiUsageEvent) => void } | undefined,
  source: AiUsageSource,
  stage: string | undefined,
  durationMs: number,
  response?: unknown,
  error?: unknown,
): void {
  if (!usage?.onEvent) return;
  try {
    usage.onEvent(toAiUsageEvent({
      source,
      stage,
      runId: usage.runId,
      attempt: usage.attempt,
      model: config.model,
      provider: config.provider ?? "minimax",
      durationMs,
      response,
      error,
    }));
  } catch {
    // Usage recording must never break the primary call.
  }
}

export function miniMaxProviderError(config: MiniMaxConfig, error: unknown): MiniMaxServiceError {
  if (error instanceof MiniMaxServiceError) return error;
  const label = providerLabel(config);
  if (error instanceof AuthenticationError) {
    return new MiniMaxServiceError("provider_authentication", `${label} API Key 无效。`);
  }
  if (typeof error === "object" && error !== null) {
    const record = error as { status?: unknown; statusCode?: unknown };
    const status = typeof record.status === "number"
      ? record.status
      : typeof record.statusCode === "number"
        ? record.statusCode
        : undefined;
    if (status === 401) return new MiniMaxServiceError("provider_authentication", `${label} API Key 无效。`);
  }
  if (error instanceof RateLimitError) {
    return new MiniMaxServiceError("provider_rate_limit", `${label} 请求过于频繁，请稍后重试。`);
  }
  if (error instanceof APIConnectionTimeoutError) {
    return new MiniMaxServiceError("provider_timeout", `${label} 响应超时，请重试。`);
  }
  if (error instanceof APIConnectionError) {
    return new MiniMaxServiceError("provider_connection", `无法连接 ${label} 服务。`);
  }
  return new MiniMaxServiceError("provider_error", `${label} 服务暂时无法完成本次请求。`);
}

export async function completePlanning(
  config: MiniMaxConfig,
  client: OpenAI,
  messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[],
  usage?: {
    source: Extract<AiUsageSource, "chat.reply" | "chat.regenerate">;
    runId?: string;
    attempt?: number;
    onEvent?: (event: AiUsageEvent) => void;
  },
  signal?: AbortSignal,
) {
  const baseParams = {
    model: config.model,
    messages,
    temperature: 0.1,
    max_completion_tokens: 8192,
    tools: [responseTool],
    tool_choice: { type: "function" as const, function: { name: "submit_product_update" } },
  };
  const providerParams = isDeepSeek(config)
    ? {}
    : { thinking: { type: "disabled" as const }, reasoning_split: true, service_tier: miniMaxServiceTier() };
  const startedAt = Date.now();
  try {
    const result = await client.chat.completions.create({ ...baseParams, ...providerParams } as never, { signal }).withResponse();
    const response = result.data;
    emitMiniMaxUsage(config, usage, usage?.source ?? "chat.reply", undefined, Date.now() - startedAt, response);
    const message = response.choices[0]?.message;
    if (!message) throw new MiniMaxServiceError("empty_model_output", "AI 未返回内容。");
    return {
      message,
      traceId: result.response.headers.get("trace-id")
        || result.response.headers.get("trace_id")
        || result.request_id
        || undefined,
    };
  } catch (error) {
    emitMiniMaxUsage(config, usage, usage?.source ?? "chat.reply", undefined, Date.now() - startedAt, undefined, error);
    throw error;
  }
}
