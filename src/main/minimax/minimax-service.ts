import OpenAI, { APIConnectionError, APIConnectionTimeoutError, AuthenticationError, RateLimitError } from "openai";
import type { AdvisorOutcome, AdvisorRequest, AiResponse, DisambiguateOutcome, DisambiguateRequest } from "../../shared/contracts.js";
import {
  MiniMaxServiceError,
  advisorOutcomeSchema,
  diagnosisSystemPrompt,
  diagnosisTool,
  disambiguateOutcomeSchema,
  disambiguateSystemPrompt,
  disambiguateTool,
  responseTool,
  systemPrompt,
} from "./minimax-constants.js";
import { parseAssistantMessage } from "./minimax-parsing.js";

function replyTimeout() {
  const parsed = Number(process.env.MINIMAX_REPLY_TIMEOUT_MS);
  return Number.isFinite(parsed) && parsed >= 30_000 ? parsed : 90_000;
}

function miniMaxServiceTier() {
  return process.env.MINIMAX_SERVICE_TIER === "priority" ? "priority" : "standard";
}

function parseDisambiguateContext(product: Record<string, unknown>, kind: DisambiguateRequest["kind"], desired: string): Record<string, unknown> {
  const ctx: Record<string, unknown> = { desired };
  const basic = (product.basicInfo as Record<string, unknown> | undefined) ?? {};
  const presentation = (product.presentation as Record<string, unknown> | undefined) ?? {};
  const operations = (product.operations as Record<string, unknown> | undefined) ?? {};
  if (kind === "province") {
    ctx.provinceInProduct = basic.province ?? null;
    ctx.recommendation = typeof presentation.recommendation === "string" ? presentation.recommendation : null;
    ctx.features = typeof presentation.features === "string" ? presentation.features : null;
  } else if (kind === "city") {
    ctx.meetingCity = basic.meetingCity ?? null;
    ctx.destinationCity = basic.destinationCity ?? null;
    ctx.pickupCity = operations.pickupCity ?? null;
  } else if (kind === "spot") {
    const itinerary = Array.isArray(product.itinerary) ? (product.itinerary as Array<Record<string, unknown>>) : [];
    ctx.itinerarySpots = itinerary.map((d) => Array.isArray(d.spots) ? d.spots : []).flat().filter((s): s is string => typeof s === "string");
    ctx.recommendation = typeof presentation.recommendation === "string" ? presentation.recommendation : null;
  } else if (kind === "station") {
    ctx.pickupCity = operations.pickupCity ?? null;
    ctx.destinationCity = basic.destinationCity ?? null;
  }
  return ctx;
}

export class MiniMaxService {
  constructor(private readonly config: { apiKey: string; baseUrl: string; model: string }) {}

  private client(timeout: number) {
    // A planning turn must fail visibly instead of silently retrying for minutes.
    return new OpenAI({ apiKey: this.config.apiKey, baseURL: this.config.baseUrl, timeout, maxRetries: 0 });
  }

  async testConnection(): Promise<void> {
    if (!this.config.apiKey) throw new MiniMaxServiceError("provider_not_configured", "请先填写 MiniMax API Key。");
    const client = this.client(20_000);
    try {
      await client.chat.completions.create({
        model: this.config.model,
        messages: [{ role: "user", content: "ping" }],
        max_completion_tokens: 1,
        thinking: { type: "disabled" },
      } as never);
    } catch (error) { this.throwProviderError(error); }
  }

  async reply(input: { message: string; product: Record<string, unknown>; history: Array<{ role: string; content: string }> }): Promise<AiResponse> {
    if (!this.config.apiKey) throw new MiniMaxServiceError("provider_not_configured", "尚未配置 MiniMax API Key。");
    const client = this.client(replyTimeout());
    const itinerary = input.product.itinerary;
    const hasExistingDraft = Array.isArray(itinerary) && itinerary.length > 0;
    const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
      { role: "system", content: systemPrompt },
      ...(hasExistingDraft ? input.history.slice(-12) : []).map((message) => ({ role: message.role === "assistant" ? "assistant" : "user", content: message.content } as OpenAI.Chat.Completions.ChatCompletionMessageParam)),
      { role: "user", content: `当前产品草稿：${JSON.stringify(input.product)}\n\n用户本轮输入：${input.message}\n\n请通过 submit_product_update 工具返回结构化结果。` },
    ];
    const startedAt = Date.now();
    console.info("[MiniMax] planning request started", { model: this.config.model, timeoutMs: replyTimeout() });
    try {
      const { message, traceId } = await this.complete(client, messages);
      const { response, isStructured } = parseAssistantMessage(message);
      const isInitialDraft = (!Array.isArray(itinerary) || itinerary.length === 0) && /生成|第一版|方案/.test(input.message);
      if (isInitialDraft && isStructured && !response.patch?.length) {
        throw new MiniMaxServiceError("invalid_model_output", "MiniMax 未返回可写入的产品方案，请重试。");
      }
      console.info("[MiniMax] planning request completed", { model: this.config.model, elapsedMs: Date.now() - startedAt, traceId });
      return response;
    } catch (error) {
      console.error("[MiniMax] planning request failed", {
        model: this.config.model,
        elapsedMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : "unknown",
      });
      this.throwProviderError(error);
    }
  }

  async diagnoseAutomationFailure(input: AdvisorRequest): Promise<AdvisorOutcome> {
    if (!this.config.apiKey) throw new MiniMaxServiceError("provider_not_configured", "尚未配置 MiniMax API Key。");
    const startedAt = Date.now();
    try {
      const response = await this.client(replyTimeout()).chat.completions.create({
        model: this.config.model,
        messages: [
          { role: "system", content: diagnosisSystemPrompt },
          { role: "user", content: `请根据以下最小安全上下文诊断，只通过 submit_failure_diagnosis 返回结果：\n${JSON.stringify({
            phase: input.phase,
            attempt: input.attempt,
            error: input.error,
            productIdExists: input.productIdExists,
            basicInfoSaved: input.basicInfoSaved,
            completedPhases: input.completedPhases,
            diagnosisHistory: input.diagnosisHistory,
          })}` },
        ],
        max_completion_tokens: 1024,
        tools: [diagnosisTool],
        tool_choice: { type: "function", function: { name: "submit_failure_diagnosis" } },
        thinking: { type: "disabled" },
        service_tier: miniMaxServiceTier(),
      } as never);
      const toolCall = response.choices[0]?.message.tool_calls?.find(
        (call) => "function" in call && call.function.name === "submit_failure_diagnosis",
      );
      if (!toolCall || !("function" in toolCall)) {
        throw new MiniMaxServiceError("invalid_model_output", "MiniMax 返回的自动录入诊断格式无效。");
      }
      let value: unknown;
      try { value = JSON.parse(toolCall.function.arguments); }
      catch { throw new MiniMaxServiceError("invalid_model_output", "MiniMax 返回的自动录入诊断格式无效。"); }
      const parsed = advisorOutcomeSchema.safeParse(value);
      if (!parsed.success) throw new MiniMaxServiceError("invalid_model_output", "MiniMax 返回的自动录入诊断格式无效。");
      const outcome = parsed.data.action === "wait_for_user"
        ? { ...parsed.data, userInstruction: parsed.data.userInstruction!.trim() }
        : { summary: parsed.data.summary, rootCause: parsed.data.rootCause, action: parsed.data.action, expectedEvidence: parsed.data.expectedEvidence };
      console.info("[MiniMax] diagnosis completed", {
        phase: input.phase,
        attempt: input.attempt,
        action: outcome.action,
        elapsedMs: Date.now() - startedAt,
      });
      return outcome;
    } catch (error) {
      const serviceError = this.providerError(error);
      console.warn("[MiniMax] diagnosis failed", {
        phase: input.phase,
        attempt: input.attempt,
        errorCode: serviceError.code,
        elapsedMs: Date.now() - startedAt,
      });
      throw serviceError;
    }
  }

  /**
   * 歧义消除：本地精确匹配不到时，发给 AI 判断。
   * - kind=province/city/spot/station 决定 prompt 约束。
   * - 返回 pickedText=null 表示“错误人选”，调用方应该跳过。
   */
  async disambiguateOption(input: DisambiguateRequest): Promise<DisambiguateOutcome> {
    if (!this.config.apiKey) throw new MiniMaxServiceError("provider_not_configured", "尚未配置 MiniMax API Key。");
    if (!Array.isArray(input.candidates) || input.candidates.length === 0) {
      return { pickedText: null, reasoning: "候选项为空" };
    }
    const startedAt = Date.now();
    try {
      const response = await this.client(replyTimeout()).chat.completions.create({
        model: this.config.model,
        messages: [
          { role: "system", content: disambiguateSystemPrompt(input.kind) },
          { role: "user", content: JSON.stringify({
            desired: input.desired,
            candidates: input.candidates.map((c) => ({ id: c.id, text: c.text })),
            productContext: parseDisambiguateContext(input.product, input.kind, input.desired),
          }) },
        ],
        max_completion_tokens: 512,
        temperature: 0.1,
        tools: [disambiguateTool],
        tool_choice: { type: "function", function: { name: "submit_disambiguation" } },
        thinking: { type: "disabled" },
        service_tier: miniMaxServiceTier(),
      } as never);
      const toolCall = response.choices[0]?.message.tool_calls?.find(
        (call) => "function" in call && call.function.name === "submit_disambiguation",
      );
      if (!toolCall || !("function" in toolCall)) {
        throw new MiniMaxServiceError("invalid_model_output", "MiniMax 未返回结构化选则结果。");
      }
      let value: unknown;
      try { value = JSON.parse(toolCall.function.arguments); }
      catch { throw new MiniMaxServiceError("invalid_model_output", "MiniMax 返回的选则结果不是合法 JSON。"); }
      const parsed = disambiguateOutcomeSchema.safeParse(value);
      if (!parsed.success) throw new MiniMaxServiceError("invalid_model_output", "MiniMax 返回的选则结果不合法。");
      const pickedText = parsed.data.pickedText && input.candidates.some((c) => c.text === parsed.data.pickedText)
        ? parsed.data.pickedText
        : null;
      console.info("[MiniMax] disambiguation completed", {
        kind: input.kind,
        desired: input.desired,
        picked: pickedText,
        elapsedMs: Date.now() - startedAt,
      });
      return { pickedText, reasoning: parsed.data.reasoning };
    } catch (error) {
      const serviceError = this.providerError(error);
      console.warn("[MiniMax] disambiguation failed", {
        kind: input.kind,
        desired: input.desired,
        errorCode: serviceError.code,
        elapsedMs: Date.now() - startedAt,
      });
      throw serviceError;
    }
  }

  private async complete(client: OpenAI, messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[]) {
    const result = await client.chat.completions.create({
      model: this.config.model, messages, temperature: 0.1, max_completion_tokens: 8192,
      tools: [responseTool],
      tool_choice: { type: "function", function: { name: "submit_product_update" } },
      thinking: { type: "disabled" },
      reasoning_split: true,
      service_tier: miniMaxServiceTier(),
    } as never).withResponse();
    const response = result.data;
    const message = response.choices[0]?.message;
    if (!message) throw new MiniMaxServiceError("empty_model_output", "MiniMax 未返回内容。");
    return { message, traceId: result.response.headers.get("trace-id") || result.response.headers.get("trace_id") || result.request_id || undefined };
  }

  private providerError(error: unknown): MiniMaxServiceError {
    if (error instanceof MiniMaxServiceError) return error;
    if (error instanceof AuthenticationError) return new MiniMaxServiceError("provider_authentication", "MiniMax API Key 无效。");
    if (error instanceof RateLimitError) return new MiniMaxServiceError("provider_rate_limit", "MiniMax 请求过于频繁，请稍后重试。");
    if (error instanceof APIConnectionTimeoutError) return new MiniMaxServiceError("provider_timeout", "MiniMax 响应超时，请重试。");
    if (error instanceof APIConnectionError) return new MiniMaxServiceError("provider_connection", "无法连接 MiniMax 服务。");
    return new MiniMaxServiceError("provider_error", "MiniMax 服务暂时无法完成本次请求。");
  }

  private throwProviderError(error: unknown): never {
    throw this.providerError(error);
  }
}
