import { stripAgentReasoning } from "../../shared/agent-visible-text.js";
import OpenAI from "openai";
import type { AgentModel, AgentModelInput, AgentToolCall } from "./types.js";

export interface OpenAIAgentModelConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  timeoutMs?: number;
  onUsage?: (usage: { inputTokens?: number; outputTokens?: number }) => void;
  /** Sanitized telemetry only: no prompts, API keys, or tool arguments. */
  onLog?: (entry: { model: string; toolNames: string[]; inputTokens?: number; outputTokens?: number }) => void;
}

interface ProviderToolCall {
  id: string;
  function?: { name: string; arguments: string };
}

interface StreamedToolCall {
  id: string;
  name: string;
  arguments: string;
}

export function parseOpenAIToolCalls(calls: ProviderToolCall[]): AgentToolCall[] {
  return calls.flatMap((call) => {
    if (!call.function) return [];
    const rawArguments = call.function.arguments;
    try {
      const parsed = JSON.parse(rawArguments) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return [{ id: call.id, name: call.function.name, arguments: {}, rawArguments, argumentError: "工具参数必须是 JSON 对象" }];
      }
      return [{ id: call.id, name: call.function.name, arguments: parsed as Record<string, unknown>, rawArguments }];
    } catch (error) {
      const message = error instanceof Error ? error.message : "无法解析 JSON";
      return [{ id: call.id, name: call.function.name, arguments: {}, rawArguments, argumentError: message }];
    }
  });
}

/** Small transport adapter: AgentCore remains testable and independent of OpenAI SDK types. */
export class OpenAIAgentModel implements AgentModel {
  private readonly client: OpenAI;
  constructor(private readonly config: OpenAIAgentModelConfig) {
    this.client = new OpenAI({ apiKey: config.apiKey, baseURL: config.baseUrl, timeout: config.timeoutMs ?? 90_000, maxRetries: 0 });
  }
  async complete(input: AgentModelInput) {
    const stream = await this.client.chat.completions.create({
      model: this.config.model,
      messages: input.messages.map((message) => ({
        role: message.role,
        content: message.content,
        ...(message.toolCallId ? { tool_call_id: message.toolCallId } : {}),
        ...(message.toolCalls ? { tool_calls: message.toolCalls.map((call) => ({
          id: call.id,
          type: "function" as const,
          function: { name: call.name, arguments: call.rawArguments ?? JSON.stringify(call.arguments) },
        })) } : {}),
      })) as OpenAI.Chat.ChatCompletionMessageParam[],
      tools: input.tools.map((tool) => ({ type: "function" as const, function: { name: tool.name, description: tool.description, parameters: tool.parameters } })),
      stream: true,
      stream_options: { include_usage: true },
    });

    let rawContent = "";
    let visibleContent = "";
    let finishReason: string | null = null;
    let sawChoice = false;
    let usage: { inputTokens?: number; outputTokens?: number } | undefined;
    const streamedCalls = new Map<number, StreamedToolCall>();

    for await (const chunk of stream) {
      if (chunk.usage) usage = {
        inputTokens: chunk.usage.prompt_tokens,
        outputTokens: chunk.usage.completion_tokens,
      };
      const choice = chunk.choices[0];
      if (!choice) continue;
      sawChoice = true;
      if (typeof choice.delta.content === "string") {
        rawContent += choice.delta.content;
        const nextVisible = stripAgentReasoning(rawContent);
        if (nextVisible !== visibleContent) {
          visibleContent = nextVisible;
          await input.onContent?.(visibleContent);
        }
      }
      for (const delta of choice.delta.tool_calls ?? []) {
        const current = streamedCalls.get(delta.index) ?? { id: "", name: "", arguments: "" };
        if (delta.id) current.id += delta.id;
        if (delta.function?.name) current.name += delta.function.name;
        if (delta.function?.arguments) current.arguments += delta.function.arguments;
        streamedCalls.set(delta.index, current);
      }
      if (choice.finish_reason) finishReason = choice.finish_reason;
    }

    if (!sawChoice) throw new Error("模型响应为空：未返回流式 choices。");
    if (!finishReason) throw new Error("模型流式响应提前结束，请重试。");
    if (finishReason === "length") {
      throw new Error("模型响应因长度限制被截断，请减少上下文后重试。");
    }
    const providerCalls: ProviderToolCall[] = [...streamedCalls.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, call]) => {
        if (!call.id || !call.name) throw new Error("模型流式工具调用缺少 id 或名称，请重试。");
        return { id: call.id, function: { name: call.name, arguments: call.arguments } };
      });
    const toolCalls = parseOpenAIToolCalls(providerCalls);
    if (usage) this.config.onUsage?.(usage);
    this.config.onLog?.({ model: this.config.model, toolNames: toolCalls.map((call) => call.name), ...usage });
    return { content: visibleContent || undefined, toolCalls, usage };
  }
}
