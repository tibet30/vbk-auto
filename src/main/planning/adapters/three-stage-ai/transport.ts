/**
 * OpenAI 调用层：
 *   - callTool：构造 system + user messages → logAIPrompt → createCompletion，
 *     找到 tool.function.arguments 并 JSON.parse；非对象 / parse 失败 →
 *     PlannerError("invalid_model_output")；
 *   - createCompletion：用 AbortController 实现 timeoutMs 自管超时（拒绝依赖
 *     OpenAI SDK 自身重试），并通过 timedCompletion 包裹把结果转换成
 *     AiUsageEvent 走 recordUsage；OpenAI SDK 错误统一过 normaliseTransportError。
 *
 * timeout 错误以 PlannerError("provider_timeout") 抛给上层。
 */

import OpenAI from "openai";
import { PlannerError } from "../../../../shared/contracts-planning.js";
import type { AiUsageSource } from "../../../../shared/contracts-ai-usage.js";
import type { AiUsageEvent } from "../../../../shared/contracts-ai-usage.js";
import type { AIPromptEntry } from "../../../ai/prompt-log.js";
import { timedCompletion, toAiUsageEvent } from "../../../ai/completion-usage.js";
import { logAIPrompt } from "../../../ai/prompt-log.js";
import { normaliseTransportError, type ChatCompletionBody } from "../openai-compatible-transport.js";
import { ENTRY_SOURCE } from "./util.js";
import type { ThreeStageTool } from "../three-stage-tools.js";

export interface CallToolDeps {
  client: OpenAI;
  timeoutMs: number;
  provider?: string;
  model: string;
  recordUsage?: (event: AiUsageEvent) => void;
  usageScope?: { localProductId: string; runId?: string };
}

export async function callTool(
  deps: CallToolDeps,
  entry: AIPromptEntry,
  messages: Array<{ role: "system" | "user"; content: string }>,
  tool: ThreeStageTool,
  extraParams: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  logAIPrompt({
    entry,
    provider: deps.provider ?? "openai-compatible",
    model: deps.model,
    messages,
  });
  const source = ENTRY_SOURCE[entry as keyof typeof ENTRY_SOURCE] ?? "planning.structureLocation";
  const response = await createCompletion(deps, {
    model: deps.model,
    messages,
    temperature: 0.1,
    max_completion_tokens: 4096,
    tools: [tool],
    tool_choice: { type: "function", function: { name: tool.function.name } },
    ...extraParams,
  }, source);
  const call = response.choices[0]?.message?.tool_calls?.find(
    (item) => "function" in item && item.function.name === tool.function.name,
  );
  if (!call || !("function" in call)) {
    throw new PlannerError("invalid_model_output", "模型未通过结构化工具返回结果。");
  }
  try {
    const parsed = JSON.parse(call.function.arguments);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not object");
    return parsed as Record<string, unknown>;
  } catch {
    throw new PlannerError("invalid_model_output", "工具返回不是合法 JSON 对象。");
  }
}

async function createCompletion(deps: CallToolDeps, body: ChatCompletionBody, source: AiUsageSource) {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new PlannerError("provider_timeout", `AI 规划响应超时（${deps.timeoutMs}ms），请重试。`));
    }, deps.timeoutMs);
  });
  const request = deps.client.chat.completions.create(
    body as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming,
    { signal: controller.signal },
  );
  request.catch(() => undefined);
  try {
    return await timedCompletion(
      async () => {
        try {
          return await Promise.race([request, timeout]);
        } catch (error) {
          throw normaliseTransportError(error);
        }
      },
      (result) => {
        if (!deps.recordUsage) return;
        deps.recordUsage(toAiUsageEvent({
          source,
          model: deps.model,
          provider: deps.provider ?? "openai-compatible",
          runId: deps.usageScope?.runId,
          durationMs: result.durationMs,
          response: result.value,
          error: result.error,
        }));
      },
    );
  } finally {
    if (timer) clearTimeout(timer);
  }
}