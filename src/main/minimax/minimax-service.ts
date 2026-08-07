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
    const planningRetryLimit = 4;
    const planningRetryInstruction =
      "上一次返回未通过结构化校验，请只返回纯 JSON 对象（仅包含 reply、patch、questions、researchTasks 四个字段），并为该轮返回至少一个可写入的 patch；不得带说明文字。";
    const isInitialDraft = (!Array.isArray(itinerary) || itinerary.length === 0) && /生成|第一版|方案/.test(input.message);
    const requiresStructuredAction = input.message.includes("上一次返回未通过结构化校验");
    const requiresWritablePatch = isInitialDraft
      || requiresStructuredAction
      || /继续|补齐|补充|调整|更新|继续生成|继续补充|再次生成|重试|重写|重新|优化|生成/.test(input.message);
    const requireActionHint = isInitialDraft
      || requiresStructuredAction
      || /继续|补齐|补充|调整|更新|修正|重新|优化|重写|重试|继续生成|继续补充|再次生成|生成/.test(input.message);
    const startedAt = Date.now();
    console.info("[MiniMax] planning request started", { model: this.config.model, timeoutMs: replyTimeout() });
    let lastError: MiniMaxServiceError | undefined;
    let lastRetryReason = "";
    for (let attempt = 0; attempt <= planningRetryLimit; attempt += 1) {
      const attemptStartedAt = Date.now();
      const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
        { role: "system", content: systemPrompt },
        ...(hasExistingDraft ? input.history.slice(-12) : []).map((message) => ({ role: message.role === "assistant" ? "assistant" : "user", content: message.content } as OpenAI.Chat.Completions.ChatCompletionMessageParam)),
        { role: "user", content: attempt === 0
          ? `当前产品草稿：${JSON.stringify(input.product)}\n\n用户本轮输入：${input.message}\n\n请通过 submit_product_update 工具返回结构化结果。`
          : `当前产品草稿：${JSON.stringify(input.product)}\n\n用户本轮输入：${input.message}\n\n${planningRetryInstruction}${lastRetryReason ? `\n\n上一次返回原因：${lastRetryReason}` : ""}` },
      ];
      try {
        const isLastAttempt = attempt >= planningRetryLimit;
        const { message, traceId } = await this.complete(client, messages);
        const { response, isStructured } = parseAssistantMessage(message);
        const hasActionHint = !!(response.patch?.length || response.questions?.length || response.researchTasks?.length);
        const hasWritablePatch = !!(response.patch?.length ?? 0);
        // 解析走 fallback 兜底（纯文本回复/未闭合引号/转义截断）的结果可能是 "未获取到..." 等占位文，
        // 这种情况即便 parseRecoveredJson 把它标 structured 也应视为无效，触发重试。
        // 当 reply 来自 model 主动输出（与 content 一致或独立纯文本），即便没有 patch 也允许放过。
        // 但当 reply 看起来是 "暂不写盘"、"等待重试" 等占位文，且没有 patch 落地，仍应触发重试。
        const isFallbackReply = typeof response.reply === "string"
          && (/^未获取到/.test(response.reply)
            || /请重试|等待.*重试|持续.*说明|先记要点|下一条回复|带上完整结构化|当前先记/.test(response.reply)
            || /不落盘|暂不落盘|暂不写入|先不写入|先不落盘|还需调整|还需补充|先回避|后补齐|仍无可写字段|暂无可写/.test(response.reply)
            || /structured response rejected|Unexpected end of JSON|Unexpected token|响应格式|返回的数据格式/.test(response.reply));
        // patch/questions/researchTasks 实际有内容（不是 0 长度）才算真正命中 action。
        // 当 reply 看起来是 fallback 占位文（"仍无可写字段"、"暂不写盘" 等）时，questions/researchTasks 单独命中不算数。
        const hasRealActionHint = (response.patch?.length ?? 0) > 0
          || (!isFallbackReply && ((response.questions?.length ?? 0) > 0
              || (response.researchTasks?.length ?? 0) > 0));
        // 有 submit_product_update 工具调用时，工具返回是主回复来源；如果工具返回无 patch 而 content 是噪音占位，
        // 应视为解析失败。content 是非空纯文本且无 tool_call 时，说明模型主动输出，可允许直接返回。
        const hasOfficialToolCall = Array.isArray(message.tool_calls)
          && message.tool_calls.some((call: any) => call.function?.name === "submit_product_update");
        const hasAnyToolCall = Array.isArray(message.tool_calls) && message.tool_calls.length > 0;
        const hasDirectContent = typeof message.content === "string" && message.content.trim().length > 0;
        // content 像是 SSE 噪音（包含 event:/data: 行）时不视为可读正文。
        const looksLikeNoise = typeof message.content === "string"
          && /(?:^|\n)\s*(?:event:|data:|\[DONE\]|keep-alive)/.test(message.content);
        // 工具名错位但 tool_call arguments 仍可解析出有意义的 reply / patch / questions，
        // 也视为模型主动输出（它在尝试提交，只是工具签名拼错），允许直接返回避免永远抛错。
        // 但只有 attempts > 0（已经重试过）时才接受 typo fallback，让首轮有修复机会。
        // patch/questions/researchTasks 至少有一个非空才算真正命中 action，否则一律按 fallback 处理。
        const hasFallbackReply = hasRealActionHint
          || (!hasOfficialToolCall && !hasAnyToolCall && hasDirectContent && !looksLikeNoise
              && typeof response.reply === "string" && response.reply.trim().length > 0 && !isFallbackReply)
          || (!hasOfficialToolCall && hasAnyToolCall && hasRealActionHint && attempt > 0);
        if (requiresWritablePatch && (!isStructured || !hasWritablePatch)) {
          if (!hasFallbackReply) {
            throw new MiniMaxServiceError(
              "invalid_model_output",
              "MiniMax 未返回可写入的产品方案，请重试。",
              typeof response.reply === "string" ? response.reply : undefined,
            );
          }
          // 工具名错位时，第一轮先容忍 fallback（避免正常抓包被永久判失败），
          // 但如果 attempts 已经用尽仍无法拿到官方工具返回，就强制抛错。
          if (!hasOfficialToolCall && hasAnyToolCall && hasRealActionHint && isLastAttempt && attempt > 0) {
            throw new MiniMaxServiceError(
              "invalid_model_output",
              "MiniMax 返回的工具签名异常，请重试。",
              typeof response.reply === "string" ? response.reply : undefined,
            );
          }
          // 当 hasOfficialToolCall 但 hasWritablePatch=false 且 reply 提到"重试"，
          // 视为模型在尝试但未完成，触发重试直到拿到 patch。
          if (hasOfficialToolCall && /重试|暂缺|仍未/.test(response.reply ?? "") && attempt < planningRetryLimit) {
            throw new MiniMaxServiceError(
              "invalid_model_output",
              "MiniMax 当前返回尚未落库，正在重试。",
              typeof response.reply === "string" ? response.reply : undefined,
            );
          }
        }
        if (requireActionHint && !requiresWritablePatch && !isStructured) {
          if (!hasFallbackReply) {
            throw new MiniMaxServiceError(
              "invalid_model_output",
              "MiniMax 未返回可写入的产品方案，请重试。",
              typeof response.reply === "string" ? response.reply : undefined,
            );
          }
        }
        if (requireActionHint && !requiresWritablePatch && isStructured && !hasActionHint) {
          if (!isLastAttempt) {
            throw new MiniMaxServiceError(
              "invalid_model_output",
              "MiniMax 未返回可写入的产品方案，请重试。",
              typeof response.reply === "string" ? response.reply : undefined,
            );
          }
        }
        console.info("[MiniMax] planning request completed", {
          model: this.config.model,
          elapsedMs: Date.now() - attemptStartedAt,
          attempt,
          traceId,
        });
        return response;
      } catch (error) {
        const serviceError = error instanceof MiniMaxServiceError ? error : this.providerError(error);
        lastError = serviceError;
        const canRetry = ["invalid_model_output", "empty_model_output"].includes(serviceError.code) && attempt < planningRetryLimit;
        console.warn("[MiniMax] planning request attempt failed", {
          model: this.config.model,
          attempt,
          canRetry,
          elapsedMs: Date.now() - attemptStartedAt,
          error: serviceError.message,
        });
        if (!canRetry) break;
        lastRetryReason = (serviceError.details ?? serviceError.message ?? "").trim().replace(/\s+/g, " ").slice(0, 180);
      }
    }
    console.error("[MiniMax] planning request failed", {
      model: this.config.model,
      elapsedMs: Date.now() - startedAt,
      error: lastError instanceof Error ? lastError.message : "unknown",
    });
    // 任何模型没给出可落盘结构的失败，都归一化为 invalid_model_output，
    // 避免上层把它误判为网络/服务异常。
    if (lastError && lastError.code !== "invalid_model_output" && lastError.code !== "empty_model_output") {
      throw new MiniMaxServiceError("invalid_model_output", lastError.message);
    }
    throw lastError ?? new MiniMaxServiceError("invalid_model_output", "MiniMax 未返回可写入的产品方案，请重试。");
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
