/**
 * OpenAI-compatible Chat Completions 的 usage 解析与计时。
 * 只读供应商返回的字段，不做本地 tokenizer 估算。
 */

import { randomUUID } from "node:crypto";
import type { AiUsageEvent, AiUsageSource } from "../../shared/contracts-ai-usage.js";

export interface ParsedCompletionUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  cachedTokens: number | null;
  reasoningTokens: number | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function nonNegInt(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : null;
}

export function parseCompletionUsage(response: unknown): ParsedCompletionUsage {
  const empty: ParsedCompletionUsage = {
    inputTokens: null,
    outputTokens: null,
    totalTokens: null,
    cachedTokens: null,
    reasoningTokens: null,
  };
  const root = asRecord(response);
  const usage = asRecord(root?.usage);
  if (!usage) return empty;

  const inputTokens = nonNegInt(usage.prompt_tokens) ?? nonNegInt(usage.input_tokens);
  const outputTokens = nonNegInt(usage.completion_tokens) ?? nonNegInt(usage.output_tokens);
  const totalTokens = nonNegInt(usage.total_tokens)
    ?? (inputTokens !== null && outputTokens !== null ? inputTokens + outputTokens : null);

  const promptDetails = asRecord(usage.prompt_tokens_details);
  const completionDetails = asRecord(usage.completion_tokens_details);

  return {
    inputTokens,
    outputTokens,
    totalTokens,
    cachedTokens: nonNegInt(promptDetails?.cached_tokens),
    reasoningTokens: nonNegInt(completionDetails?.reasoning_tokens),
  };
}

export async function timedCompletion<T>(
  run: () => Promise<T>,
  record: (result: { durationMs: number; value?: T; error?: unknown }) => void,
): Promise<T> {
  const started = Date.now();
  try {
    const value = await run();
    try {
      record({ durationMs: Math.max(0, Date.now() - started), value });
    } catch {
      // recorder must never break the primary call
    }
    return value;
  } catch (error) {
    try {
      record({ durationMs: Math.max(0, Date.now() - started), error });
    } catch {
      // recorder must never break the primary call
    }
    throw error;
  }
}

function errorCodeOf(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && code.trim() ? code.trim() : undefined;
}

/** Build a product-attributed usage event from a completion result. */
export function toAiUsageEvent(input: {
  source: AiUsageSource;
  stage?: string;
  attempt?: number;
  model: string;
  provider: string;
  runId?: string;
  durationMs: number;
  response?: unknown;
  error?: unknown;
}): AiUsageEvent {
  const endedAt = new Date().toISOString();
  const startedAt = new Date(Date.now() - Math.max(0, input.durationMs)).toISOString();
  const usage = input.response ? parseCompletionUsage(input.response) : parseCompletionUsage(null);
  return {
    id: randomUUID(),
    runId: input.runId,
    source: input.source,
    stage: input.stage,
    attempt: input.attempt,
    model: input.model,
    provider: input.provider,
    status: input.error ? "error" : "ok",
    errorCode: input.error ? errorCodeOf(input.error) : undefined,
    startedAt,
    endedAt,
    durationMs: Math.max(0, input.durationMs),
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens,
    cachedTokens: usage.cachedTokens,
    reasoningTokens: usage.reasoningTokens,
  };
}
