import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { isStepCount, jsonSchema, streamText, type LanguageModel, type ModelMessage, type ToolSet } from "ai";
import { stripAgentReasoning } from "../../shared/agent-visible-text.js";
import { logWarn } from "../../shared/log-timestamp.js";
import { attemptWithPromptRepair, sanitisePromptMessages, type PromptRepairLevel } from "../ai/prompt-moderation-repair.js";
import { toModelMessages } from "./ai-sdk-transcript.js";
import type { AgentModel, AgentModelInput, AgentModelMessage, AgentModelResult, AgentToolCall, AgentToolDefinition } from "./types.js";

export interface AiSdkAgentModelConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  timeoutMs?: number;
  /** Provider-specific body fields (MiniMax thinking / service_tier) merged into every request. */
  extraParams?: Record<string, unknown>;
  onUsage?: (usage: { inputTokens?: number; outputTokens?: number; cachedTokens?: number }) => void;
  /** Sanitized telemetry only: no prompts, API keys, or tool arguments. */
  onLog?: (entry: { model: string; toolNames: string[]; inputTokens?: number; outputTokens?: number }) => void;
}

/**
 * AI SDK transport adapter behind the same `AgentModel` contract as `OpenAIAgentModel`.
 *
 * 只替换传输层，不接管回合调度：单步 `streamText`（`isStepCount(1)`）+ 无 execute 的工具定义，
 * 工具执行、门禁、审批、事件流仍由 AgentCore 负责。
 */
export class AiSdkAgentModel implements AgentModel {
  private readonly model: LanguageModel;

  constructor(private readonly config: AiSdkAgentModelConfig) {
    const provider = createOpenAICompatible({
      name: "vbk-agent",
      baseURL: config.baseUrl,
      apiKey: config.apiKey,
      // MiniMax 要求 thinking / reasoning_split / service_tier 走 body 顶层字段，
      // providerOptions 的 schema 不接受任意键，只能在这里合并。
      ...(config.extraParams
        ? { transformRequestBody: (body: Record<string, unknown>) => ({ ...body, ...config.extraParams }) }
        : {}),
    });
    this.model = provider.chatModel(config.model);
  }

  async complete(input: AgentModelInput): Promise<AgentModelResult> {
    const timeoutMs = this.config.timeoutMs ?? 90_000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      // 修复等级作用在 provider-neutral 消息上：工具结果正文是纯字符串，脱敏才能覆盖到
      // POI 名称与行程文案；转成 ModelMessage 之后只改 text part，会漏掉 tool output。
      return await attemptWithPromptRepair({
        label: "agent.reply",
        buildMessages: (level) => toModelMessages(sanitiseAgentMessages(input.messages, level)),
        call: (messages) => this.callOnce(messages as ModelMessage[], input, controller.signal),
      });
    } finally {
      clearTimeout(timer);
    }
  }

  private async callOnce(
    messages: ModelMessage[],
    input: AgentModelInput,
    signal: AbortSignal,
  ): Promise<AgentModelResult> {
    // 流内的 provider 错误默认只被 SDK 消费掉，最终只剩一句「No output generated」；
    // 这里先留住真实原因，供空响应时写日志与诊断，用户可见文案仍由上层统一中文化。
    let streamFailure: unknown;
    const result = streamText({
      model: this.model,
      messages,
      tools: this.tools(input.tools),
      abortSignal: signal,
      // 单步：只做一次模型调用，工具循环由 AgentCore 驱动。
      stopWhen: isStepCount(1),
      // 完成检查反馈以 system 消息插在对话中间，语义位置不能丢。
      allowSystemInMessages: true,
      onError: ({ error }) => { streamFailure = error; },
    });

    let raw = "";
    let visible = "";
    try {
      for await (const delta of result.textStream) {
        raw += delta;
        const next = stripAgentReasoning(raw);
        if (next !== visible) {
          visible = next;
          await input.onContent?.(next);
        }
      }
    } catch (error) {
      if (signal.aborted) throw new Error("模型响应超时，请重试。");
      throw withResponseBody(error);
    }

    const [finishReason, providerCalls, usage] = await Promise.all([
      result.finishReason,
      result.toolCalls,
      result.totalUsage,
    ]).catch((error: unknown) => {
      if (signal.aborted) throw new Error("模型响应超时，请重试。");
      throw withResponseBody(error);
    });

    if (signal.aborted && finishReason !== "stop" && finishReason !== "tool-calls") {
      throw new Error("模型响应超时，请重试。");
    }
    if (finishReason === "length") {
      throw new Error("模型响应因长度限制被截断，请减少上下文后重试。");
    }
    if (!finishReason) {
      throw emptyOutputError(streamFailure, "模型流式响应提前结束，请重试。");
    }

    const toolCalls = providerCalls.map((call) => toToolCall(call.toolCallId, call.toolName, call.input));
    if (!raw.trim() && !toolCalls.length && finishReason !== "tool-calls") {
      throw emptyOutputError(streamFailure, "模型响应为空：未返回可用内容。");
    }

    const mapped = {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cachedTokens: usage.inputTokenDetails?.cacheReadTokens,
    };
    this.config.onUsage?.(mapped);
    this.config.onLog?.({
      model: this.config.model,
      toolNames: toolCalls.map((call) => call.name),
      inputTokens: mapped.inputTokens,
      outputTokens: mapped.outputTokens,
    });
    return { content: visible || undefined, toolCalls, usage: mapped };
  }

  private tools(definitions: AgentToolDefinition[]): ToolSet {
    return Object.fromEntries(definitions.map((definition) => [definition.name, {
      description: definition.description,
      inputSchema: jsonSchema(definition.parameters as Parameters<typeof jsonSchema>[0]),
    }]));
  }
}

/**
 * 只对 content 做审核修复，保留 toolCalls / toolCallId 等结构字段。
 * sanitisePromptMessages 的泛型约束带 index signature，AgentModelMessage 不满足。
 */
function sanitiseAgentMessages(
  messages: readonly AgentModelMessage[],
  level: PromptRepairLevel,
): AgentModelMessage[] {
  if (level === 0) return [...messages];
  const sanitised = sanitisePromptMessages(messages.map(({ role, content }) => ({ role, content })), level);
  return messages.map((message, index) => ({
    ...message,
    content: (sanitised[index]?.content as string | undefined) ?? message.content,
  }));
}

function toToolCall(id: string, name: string, input: unknown): AgentToolCall {
  if (input && typeof input === "object" && !Array.isArray(input)) {
    return { id, name, arguments: input as Record<string, unknown>, rawArguments: JSON.stringify(input) };
  }
  return {
    id,
    name,
    arguments: {},
    rawArguments: typeof input === "string" ? input : JSON.stringify(input),
    argumentError: "工具参数必须是 JSON 对象",
  };
}

/**
 * 空响应单独留一条诊断：真实原因（上游断流、代理截断、审核）只在 streamFailure 里，
 * 不写日志就只能看到「没有内容」这句话，无法定位。
 */
function emptyOutputError(streamFailure: unknown, message: string): Error {
  const detail = streamFailure instanceof Error ? streamFailure.message : "";
  if (detail) logWarn("[agent] model stream ended without content", detail);
  const error = new Error(message);
  error.name = "AgentEmptyOutputError";
  if (detail) Object.assign(error, { agentDetail: detail });
  return error;
}

/**
 * AI SDK 的 APICallError 把原始响应体放在 responseBody，而 message 往往是通用描述。
 * 审核拒绝（status_code 1026）与瞬时故障（5xx/429）的判定都依赖文本，所以把响应体
 * 并入 message，同时保留 statusCode 供 isTransientModelError 使用。
 */
function withResponseBody(error: unknown): unknown {
  if (!error || typeof error !== "object") return error;
  const body = (error as { responseBody?: unknown }).responseBody;
  if (typeof body !== "string" || !body) return error;
  const message = error instanceof Error ? error.message : String(error);
  if (body.includes(message) || message.includes(body)) return error;
  const wrapped = new Error(`${message} ${body}`);
  wrapped.name = error instanceof Error ? error.name : "AiSdkTransportError";
  const statusCode = (error as { statusCode?: unknown }).statusCode;
  const code = (error as { code?: unknown }).code;
  Object.assign(wrapped, { ...(statusCode !== undefined ? { statusCode } : {}), ...(code !== undefined ? { code } : {}) });
  return wrapped;
}
