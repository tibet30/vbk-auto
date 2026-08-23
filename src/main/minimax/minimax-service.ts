/**
 * MiniMax / Evolink 客户端封装（MiniMaxService）及其周边工具：
 *   - 调用聊天接口完成规划对话（reply），内置结构化输出解析与重试；
 *   - 调用诊断接口给出自动录入失败的下一步建议（diagnoseAutomationFailure）；
 *   - 在 VBK 下拉候选项本地无法精确匹配时调用消歧接口（disambiguateOption）。
 *
 * 任何 OpenAI SDK 抛出的异常都会被 providerError() 归一化为 MiniMaxServiceError，
 * 外层调用方按 errorCode 决定 retry / 回退 / 报错。
 */

import OpenAI, { APIConnectionError, APIConnectionTimeoutError, AuthenticationError, RateLimitError } from "openai";
import type { AdvisorOutcome, AdvisorRequest, AiResponse, AiUsageEvent, AiUsageSource, DisambiguateOutcome, DisambiguateRequest } from "../../shared/contracts.js";
import { logError, logInfo, logWarn } from "../../shared/log-timestamp.js";
import { toAiUsageEvent } from "../ai/completion-usage.js";
import { logAIPrompt } from "../ai/prompt-log.js";
import {
  MiniMaxServiceError,
  advisorOutcomeSchema,
  diagnosisSystemPrompt,
  diagnosisTool,
  disambiguateOutcomeSchema,
  disambiguateSystemPrompt,
  disambiguateTool,
  responseTool,
  subtitleOutcomeSchema,
  subtitleSystemPrompt,
  subtitleTool,
  systemPrompt,
} from "./minimax-constants.js";
import { parseAssistantMessage } from "./minimax-parsing.js";

/**
 * 单轮回复的 OpenAI 客户端超时（毫秒）：优先读取环境变量 MINIMAX_REPLY_TIMEOUT_MS，
 * 但要求至少 30s，否则回退到默认值 90_000，避免误把合理的等待时间截短。
 */
function replyTimeout() {
  const parsed = Number(process.env.MINIMAX_REPLY_TIMEOUT_MS);
  return Number.isFinite(parsed) && parsed >= 30_000 ? parsed : 90_000;
}

/** 下拉消歧只辅助一次页面点击，不能沿用规划对话的 90 秒等待。 */
function disambiguationTimeout() {
  const parsed = Number(process.env.MINIMAX_DISAMBIGUATION_TIMEOUT_MS);
  return Number.isFinite(parsed) && parsed >= 1_000 && parsed <= 15_000 ? parsed : 8_000;
}

/**
 * 读取 MiniMax 服务等级（"priority" / "standard"）；默认 standard，
 * 仅当环境变量显式设置为 "priority" 才使用付费优先级通道。
 */
function miniMaxServiceTier() {
  return process.env.MINIMAX_SERVICE_TIER === "priority" ? "priority" : "standard";
}

/**
 * 从产品 JSON 中按 kind（province / city / spot / station）抽取 disambiguation 需要的最小上下文：
 * 比如 spot 类型只暴露行程中所有 spots + presentation.recommendation/failures 等线索，
 * 用于在选择时让模型知道「产品主要讲哪里」。
 */
function parseDisambiguateContext(product: Record<string, unknown>, input: DisambiguateRequest): Record<string, unknown> {
  const { kind, desired } = input;
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
    ctx.stationSubtype = input.stationSubtype ?? null;
  }
  return ctx;
}

/**
 * MiniMax（及其兼容代理，provider="deepseek" 即 Evolink）客户端封装。
 * 负责三件事：连通性 ping、规划对话（reply）、自动化失败诊断（diagnoseAutomationFailure）、
 * 以及本地精确匹配失败时的下拉选项消歧（disambiguateOption）。每个公共方法都把 OpenAI 异常
 * 归一化为 MiniMaxServiceError 并由调用方按 code 决定下一步动作。
 */
export class MiniMaxService {
  /**
   * 构造 MiniMaxService。
   * @param config.apiKey 必须，否则调用任何方法都会抛 provider_not_configured
   * @param config.baseUrl OpenAI 兼容 baseURL
   * @param config.model 当前默认模型
   * @param config.provider "deepseek" 表示走 Evolink，否则走 MiniMax 默认参数
   */
  constructor(private readonly config: { apiKey: string; baseUrl: string; model: string; provider?: string }) {}
  /** 当前 provider 是否为 DeepSeek/Evolink，用于切换 OpenAI 参数（thinking / reasoning_split 等不支持）。 */
  private get isDeepSeek() { return this.config.provider === "deepseek"; }
  // 错误消息中显示的 provider 名：provider 为 "deepseek" 时显示 "Evolink"，否则默认 "MiniMax"。
  private get providerLabel() { return this.isDeepSeek ? "Evolink" : "MiniMax"; }
  /**
   * 构造一个禁用自动重试的 OpenAI 客户端：单轮规划请求必须显式失败，
   * 而非被 SDK 默认重试拖到分钟级，便于上层按 code 决定续跑 / 终止。
   */
  private client(timeout: number) {
    // A planning turn must fail visibly instead of silently retrying for minutes.
    return new OpenAI({ apiKey: this.config.apiKey, baseURL: this.config.baseUrl, timeout, maxRetries: 0 });
  }

  /**
   * 用一句「ping」测试当前 apiKey / 模型是否可用；任何 OpenAI 异常都会被归一化抛出。
   * 仅用于设置页和诊断页的连接测试，不会进入主链路。
   */
  async testConnection(signal?: AbortSignal): Promise<void> {
    if (!this.config.apiKey) throw new MiniMaxServiceError("provider_not_configured", `请先填写 ${this.providerLabel} API Key。`);
    const client = this.client(20_000);
    const messages = [{ role: "user", content: "ping" }];
    try {
      logAIPrompt({
        entry: "MiniMax.testConnection",
        provider: this.config.provider ?? "minimax",
        model: this.config.model,
        messages,
      });
      const baseParams = {
        model: this.config.model,
        messages,
        max_completion_tokens: 1,
      };
      const providerParams = this.isDeepSeek ? {} : { thinking: { type: "disabled" as const } };
      await client.chat.completions.create({ ...baseParams, ...providerParams } as never, { signal });
    } catch (error) { this.throwProviderError(error); }
  }

  /**
   * 主链路规划对话：以 systemPrompt + history + 用户本轮输入向 AI 请求一次结构化补全，
   * 解析得到 AiResponse（reply / patch / questions / researchTasks），期间对 invalid_model_output
   * / empty_model_output 等可重试错误最多重试 4 次；最终抛 MiniMaxServiceError。
   * 区分首版生成（强制携带 patch）与对话微调（patch 可选但仍要走结构化）。
   */
  async reply(input: {
    message: string;
    product: Record<string, unknown>;
    history: Array<{ role: string; content: string }>;
    usage?: { localProductId: string; source: Extract<AiUsageSource, "chat.reply" | "chat.regenerate">; runId?: string; onEvent?: (event: AiUsageEvent) => void };
    signal?: AbortSignal;
  }): Promise<AiResponse> {
    if (!this.config.apiKey) throw new MiniMaxServiceError("provider_not_configured", `尚未配置 ${this.providerLabel} API Key。`);
    const client = this.client(replyTimeout());
    const itinerary = input.product.itinerary;
    const hasExistingDraft = Array.isArray(itinerary) && itinerary.length > 0;
    // 结构化输出只保留 1 次修复机会；外层 ai:send 不再重复包网络重试。
    const planningRetryLimit = 1;
    const planningRetryInstruction =
      "上一次返回未通过结构化校验，请只返回纯 JSON 对象（仅包含 reply、patch、questions、researchTasks 四个字段），并为该轮返回至少一个可写入的 patch；不得带说明文字。";
    const isInitialDraft = (!Array.isArray(itinerary) || itinerary.length === 0) && /生成|第一版|方案/.test(input.message);
    const requiresStructuredAction = input.message.includes("上一次返回未通过结构化校验");
    const isExplanationOnly = /说明|解释/.test(input.message);
    const requiresWritablePatch = isInitialDraft
      || requiresStructuredAction
      || (!isExplanationOnly && /继续|补齐|补充|调整|更新|继续生成|继续补充|再次生成|重试|重写|重新|优化|生成/.test(input.message));
    const requireActionHint = isInitialDraft
      || requiresStructuredAction
      || /继续|补齐|补充|调整|更新|修正|重新|优化|重写|重试|继续生成|继续补充|再次生成|生成/.test(input.message);
    const startedAt = Date.now();
    logInfo("[AI] planning request started", { provider: this.config.provider ?? "minimax", model: this.config.model, timeoutMs: replyTimeout() });
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
        logAIPrompt({
          entry: "MiniMax.reply",
          provider: this.config.provider ?? "minimax",
          model: this.config.model,
          attempt,
          messages,
        });
        const { message, traceId } = await this.complete(client, messages, input.usage ? {
          source: input.usage.source,
          runId: input.usage.runId,
          attempt,
          onEvent: input.usage.onEvent,
        } : undefined, input.signal);
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
            || /不落盘|暂不落盘|暂不写入|先不写入|先不落盘|还需调整|还需补充|先回避|后补齐|仍无可写字段|暂无可写|先回传/.test(response.reply)
            || /字段类型|类型错误|应重试|重试修正/.test(response.reply)
            || /structured response rejected|Unexpected end of JSON|Unexpected token|响应格式|返回的数据格式/.test(response.reply));
        // patch/questions/researchTasks 实际有内容（不是 0 长度）才算真正命中 action。
        // 当 reply 看起来是 fallback 占位文（"仍无可写字段"、"暂不写盘" 等）时，questions/researchTasks 单独命中不算数。
        // patch/questions/researchTasks 实际有内容（不是 0 长度）才算真正命中 action。
        // 当 requiresWritablePatch 强制要求写入 patch 时，questions/researchTasks 单独命中不算数（需要 patch 才能落库）。
        const hasRealActionHint = (response.patch?.length ?? 0) > 0
          || (!requiresWritablePatch && !isFallbackReply && ((response.questions?.length ?? 0) > 0
              || (response.researchTasks?.length ?? 0) > 0));
        // reply 看起来是单字占位（"heartbeat"、"ok"、"done" 之类）时不算实质内容，避免假阳性接受。
        const looksLikeTrivialReply = typeof response.reply === "string" && /^(?:heartbeat|ok|done|ack|ping|received|好的|收到|ok!|yes)\.?$/i.test(response.reply.trim());
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
        // retry attempt > 0 时，official tool_call 但没 patch 但 reply 有可读内容也算 fallback（已经给过一次机会）。
        const hasFallbackReply = hasRealActionHint
          || (!hasOfficialToolCall && !hasAnyToolCall && hasDirectContent && !looksLikeNoise
              && typeof response.reply === "string" && response.reply.trim().length > 0 && !isFallbackReply)
          || (!hasOfficialToolCall && hasAnyToolCall && hasRealActionHint && attempt > 0)
          || (hasOfficialToolCall && attempt > 0 && !looksLikeTrivialReply
              && typeof response.reply === "string" && response.reply.trim().length > 0 && !isFallbackReply);
        if (requiresWritablePatch && !hasWritablePatch && isFallbackReply) {
          throw new MiniMaxServiceError(
            "invalid_model_output",
            `${this.providerLabel} 未返回可写入的产品方案，请重试。`,
            typeof response.reply === "string" ? response.reply : undefined,
          );
        }
        if (requiresWritablePatch || (hasOfficialToolCall && isStructured && !hasWritablePatch)) {
          const structuredEmptyDirectResponse = isInitialDraft
            && isStructured
            && !hasWritablePatch
            && !hasOfficialToolCall
            && !hasActionHint;
          if (structuredEmptyDirectResponse || (!hasFallbackReply && !isStructured)) {
            throw new MiniMaxServiceError(
              "invalid_model_output",
              `${this.providerLabel} 未返回可写入的产品方案，请重试。`,
              typeof response.reply === "string" ? response.reply : undefined,
            );
          }
          // 任何情况下（即使 requiresWritablePatch=false），reply 是 "已截断"、"抓包片段" 等占位但 hasOfficialToolCall 存在时，触发重试
          if (hasOfficialToolCall && /截断|待补齐|抓包片段|先返回|先给|暂不可写|占位|未携带/.test(response.reply ?? "") && attempt < planningRetryLimit) {
            throw new MiniMaxServiceError(
              "invalid_model_output",
              `${this.providerLabel} 当前返回尚未落库，正在重试。`,
              typeof response.reply === "string" ? response.reply : undefined,
            );
          }
          // 工具名错位且 hasWritablePatch=true 时（patch 来自错误工具签名解析的 fallback），
          // 第一次 attempt 也要重试，避免 typo 一次性通过。
          if (!hasOfficialToolCall && hasAnyToolCall && hasWritablePatch && attempt === 0) {
            throw new MiniMaxServiceError(
              "invalid_model_output",
              `${this.providerLabel} 返回的工具签名异常，请重试。`,
              typeof response.reply === "string" ? response.reply : undefined,
            );
          }
          // 工具名错位时，第一轮先容忍 fallback（避免正常抓包被永久判失败），
          // 但如果 attempts 已经用尽仍无法拿到官方工具返回，就强制抛错。
          if (!hasOfficialToolCall && hasAnyToolCall && hasRealActionHint && isLastAttempt && attempt > 0) {
            throw new MiniMaxServiceError(
              "invalid_model_output",
              `${this.providerLabel} 返回的工具签名异常，请重试。`,
              typeof response.reply === "string" ? response.reply : undefined,
            );
          }
          // 当 hasOfficialToolCall 但 hasWritablePatch=false 且 reply 包含 "重试" / "暂缺" / "仍未"（明显占位词），
          // 视为模型在尝试但未完成，触发重试直到拿到 patch。
          // 仅在 hasWritablePatch=false 时启用，避免 "工具片段重试成功" 这种包含"重试"的成功回复被误判。
          if (hasOfficialToolCall && !hasWritablePatch && /重试|暂缺|仍未/.test(response.reply ?? "") && attempt < planningRetryLimit) {
            throw new MiniMaxServiceError(
              "invalid_model_output",
              `${this.providerLabel} 当前返回尚未落库，正在重试。`,
              typeof response.reply === "string" ? response.reply : undefined,
            );
          }
        }
        if (requireActionHint && !requiresWritablePatch && !isStructured) {
          if (!hasFallbackReply) {
            throw new MiniMaxServiceError(
              "invalid_model_output",
              `${this.providerLabel} 未返回可写入的产品方案，请重试。`,
              typeof response.reply === "string" ? response.reply : undefined,
            );
          }
        }
        if (requireActionHint && !requiresWritablePatch && isStructured && !hasActionHint) {
          if (!isLastAttempt) {
            throw new MiniMaxServiceError(
              "invalid_model_output",
              `${this.providerLabel} 未返回可写入的产品方案，请重试。`,
              typeof response.reply === "string" ? response.reply : undefined,
            );
          }
        }
        logInfo("[AI] planning request completed", {
          provider: this.config.provider ?? "minimax",
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
        logWarn("[AI] planning request attempt failed", {
          provider: this.config.provider ?? "minimax",
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
    logError("[AI] planning request failed", {
      provider: this.config.provider ?? "minimax",
      model: this.config.model,
      elapsedMs: Date.now() - startedAt,
      error: lastError instanceof Error ? lastError.message : "unknown",
    });
    // 解析/空输出失败（invalid_model_output、empty_model_output）原样抛出；
    // provider_error / provider_authentication / provider_rate_limit / provider_timeout / provider_connection
    // 必须保留原始 code/message/details，避免被外层误判为结构化失败并反复重试。
    throw lastError ?? new MiniMaxServiceError("invalid_model_output", `${this.providerLabel} 未返回可写入的产品方案，请重试。`);
  }

  /**
   * 当 VBK 自动化阶段多次失败时调用 AI 做诊断：传入最小化失败上下文（阶段 / attempt / error /
   * productId 是否存在 / basicInfo 是否已存 / 已完成阶段 / 历史诊断），模型必须通过
   * submit_failure_diagnosis 工具回 action（retry / reload / wait_for_user），
   * 由 orchestrator 决定继续自动重试还是回到 needs_user。返回的 outcome.userInstruction
   * 字段仅在 action = wait_for_user 时有意义。
   */
  async diagnoseAutomationFailure(input: AdvisorRequest & {
    usage?: { localProductId: string; stage?: string; onEvent?: (event: AiUsageEvent) => void };
  }): Promise<AdvisorOutcome> {
    if (!this.config.apiKey) throw new MiniMaxServiceError("provider_not_configured", `尚未配置 ${this.providerLabel} API Key。`);
    const startedAt = Date.now();
    const messages = [
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
    ];
    try {
      logAIPrompt({
        entry: "MiniMax.diagnoseAutomationFailure",
        provider: this.config.provider ?? "minimax",
        model: this.config.model,
        messages,
      });
      const response = await this.client(replyTimeout()).chat.completions.create({
        model: this.config.model,
        messages,
        max_completion_tokens: 1024,
        tools: [diagnosisTool],
        tool_choice: { type: "function", function: { name: "submit_failure_diagnosis" } },
        thinking: { type: "disabled" },
        service_tier: miniMaxServiceTier(),
      } as never);
      this.emitUsage(input.usage, "automation.diagnose", input.phase, Date.now() - startedAt, response);
      const toolCall = response.choices[0]?.message.tool_calls?.find(
        (call) => "function" in call && call.function.name === "submit_failure_diagnosis",
      );
      if (!toolCall || !("function" in toolCall)) {
        throw new MiniMaxServiceError("invalid_model_output", `${this.providerLabel} 返回的自动录入诊断格式无效。`);
      }
      let value: unknown;
      try { value = JSON.parse(toolCall.function.arguments); }
      catch { throw new MiniMaxServiceError("invalid_model_output", `${this.providerLabel} 返回的自动录入诊断格式无效。`); }
      const parsed = advisorOutcomeSchema.safeParse(value);
      if (!parsed.success) throw new MiniMaxServiceError("invalid_model_output", `${this.providerLabel} 返回的自动录入诊断格式无效。`);
      const outcome = parsed.data.action === "wait_for_user"
        ? { ...parsed.data, userInstruction: parsed.data.userInstruction!.trim() }
        : { summary: parsed.data.summary, rootCause: parsed.data.rootCause, action: parsed.data.action, expectedEvidence: parsed.data.expectedEvidence };
      logInfo("[AI] diagnosis completed", { provider: this.config.provider ?? "minimax", phase: input.phase, attempt: input.attempt, action: outcome.action, elapsedMs: Date.now() - startedAt });
      return outcome;
    } catch (error) {
      const serviceError = this.providerError(error);
      this.emitUsage(input.usage, "automation.diagnose", input.phase, Date.now() - startedAt, undefined, serviceError);
      logWarn("[AI] diagnosis failed", {
        provider: this.config.provider ?? "minimax",
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
   *   - kind=province/city/spot/station 决定 prompt 约束。
   *   - 返回 pickedText=null 表示"无法决定 / 应当跳过"，由调用方继续 fallback。
   *   - 当模型返回的 pickedText 不在 candidates 文本中时也会被强制清成 null，防止 AI 自创 ID/文本。
   */
  async disambiguateOption(input: DisambiguateRequest & {
    usage?: { localProductId: string; stage?: string; onEvent?: (event: AiUsageEvent) => void };
  }): Promise<DisambiguateOutcome> {
    if (!this.config.apiKey) throw new MiniMaxServiceError("provider_not_configured", `尚未配置 ${this.providerLabel} API Key。`);
    if (!Array.isArray(input.candidates) || input.candidates.length === 0) {
      return { pickedText: null, reasoning: "候选项为空" };
    }
    const startedAt = Date.now();
    try {
      const messages = [
        { role: "system", content: disambiguateSystemPrompt(input.kind) },
        { role: "user", content: JSON.stringify({
          desired: input.desired,
          stationSubtype: input.stationSubtype ?? null,
          candidates: input.candidates.map((c) => ({ id: c.id, text: c.text })),
          productContext: parseDisambiguateContext(input.product, input),
        }) },
      ];
      logAIPrompt({
        entry: "MiniMax.disambiguateOption",
        provider: this.config.provider ?? "minimax",
        model: this.config.model,
        messages,
      });
      const response = await this.client(disambiguationTimeout()).chat.completions.create({
        model: this.config.model,
        messages,
        max_completion_tokens: 512,
        temperature: 0.1,
        tools: [disambiguateTool],
        tool_choice: { type: "function", function: { name: "submit_disambiguation" } },
        thinking: { type: "disabled" },
        service_tier: miniMaxServiceTier(),
      } as never);
      this.emitUsage(input.usage, "automation.disambiguate", input.usage?.stage ?? input.kind, Date.now() - startedAt, response);
      const toolCall = response.choices[0]?.message.tool_calls?.find(
        (call) => "function" in call && call.function.name === "submit_disambiguation",
      );
      if (!toolCall || !("function" in toolCall)) {
        throw new MiniMaxServiceError("invalid_model_output", `${this.providerLabel} 未返回结构化选择结果。`);
      }
      let value: unknown;
      try { value = JSON.parse(toolCall.function.arguments); }
      catch { throw new MiniMaxServiceError("invalid_model_output", `${this.providerLabel} 返回的选择结果不是合法 JSON。`); }
      const parsed = disambiguateOutcomeSchema.safeParse(value);
      if (!parsed.success) throw new MiniMaxServiceError("invalid_model_output", `${this.providerLabel} 返回的选择结果不合法。`);
      const pickedText = parsed.data.pickedText && input.candidates.some((c) => c.text === parsed.data.pickedText)
        ? parsed.data.pickedText
        : null;
      logInfo("[AI] disambiguation completed", {
        provider: this.config.provider ?? "minimax",
        kind: input.kind,
        desired: input.desired,
        picked: pickedText,
        elapsedMs: Date.now() - startedAt,
      });
      return { pickedText, reasoning: parsed.data.reasoning };
    } catch (error) {
      const serviceError = this.providerError(error);
      this.emitUsage(input.usage, "automation.disambiguate", input.usage?.stage ?? input.kind, Date.now() - startedAt, undefined, serviceError);
      logWarn("[AI] disambiguation failed", {
        provider: this.config.provider ?? "minimax",
        kind: input.kind,
        desired: input.desired,
        errorCode: serviceError.code,
        elapsedMs: Date.now() - startedAt,
      });
      throw serviceError;
    }
  }

  /**
   * 单字段重新生成：AI 副标题（basicInfo.subtitle）。
   * 只返回候选副标题字符串，**不写入产品**；由调用方展示候选、用户确认后再落库。
   * 使用专用 submit_subtitle 工具 + 更高温度，让「重新生成」能产出多样候选。
   */
  async regenerateSubtitle(input: {
    product: Record<string, unknown>;
    usage?: { localProductId: string; onEvent?: (event: AiUsageEvent) => void };
    signal?: AbortSignal;
  }): Promise<string> {
    if (!this.config.apiKey) throw new MiniMaxServiceError("provider_not_configured", `尚未配置 ${this.providerLabel} API Key。`);
    const startedAt = Date.now();
    const basic = (input.product.basicInfo as Record<string, unknown> | undefined) ?? {};
    const sales = (input.product.sales as Record<string, unknown> | undefined) ?? {};
    const presentation = (input.product.presentation as Record<string, unknown> | undefined) ?? {};
    const context = {
      meetingCity: basic.meetingCity ?? null,
      destinationCity: basic.destinationCity ?? null,
      days: basic.days ?? null,
      nights: basic.nights ?? null,
      productForm: sales.productForm ?? null,
      productType: sales.productType ?? null,
      existingSubtitle: typeof basic.subtitle === "string" ? basic.subtitle : null,
      recommendation: typeof presentation.recommendation === "string" ? presentation.recommendation : null,
    };
    const messages = [
      { role: "system", content: subtitleSystemPrompt },
      { role: "user", content: `产品上下文：${JSON.stringify(context)}\n\n请生成一个新的副标题候选。` },
    ];
    try {
      logAIPrompt({
        entry: "MiniMax.regenerateSubtitle",
        provider: this.config.provider ?? "minimax",
        model: this.config.model,
        messages,
      });
      const providerParams = this.isDeepSeek
        ? {}
        : { thinking: { type: "disabled" as const }, service_tier: miniMaxServiceTier() };
      const response = await this.client(replyTimeout()).chat.completions.create({
        model: this.config.model,
        messages,
        max_completion_tokens: 256,
        temperature: 0.9,
        tools: [subtitleTool],
        tool_choice: { type: "function", function: { name: "submit_subtitle" } },
        ...providerParams,
      } as never, { signal: input.signal });
      this.emitUsage(input.usage, "chat.regenerate", "subtitle", Date.now() - startedAt, response);
      const toolCall = response.choices[0]?.message.tool_calls?.find(
        (call) => "function" in call && call.function.name === "submit_subtitle",
      );
      if (!toolCall || !("function" in toolCall)) {
        throw new MiniMaxServiceError("invalid_model_output", `${this.providerLabel} 未返回副标题候选。`);
      }
      let value: unknown;
      try { value = JSON.parse(toolCall.function.arguments); }
      catch { throw new MiniMaxServiceError("invalid_model_output", `${this.providerLabel} 返回的副标题格式无效。`); }
      const parsed = subtitleOutcomeSchema.safeParse(value);
      if (!parsed.success) throw new MiniMaxServiceError("invalid_model_output", `${this.providerLabel} 返回的副标题不合法。`);
      const subtitle = parsed.data.subtitle.trim();
      logInfo("[AI] subtitle regeneration completed", {
        provider: this.config.provider ?? "minimax",
        elapsedMs: Date.now() - startedAt,
      });
      return subtitle;
    } catch (error) {
      const serviceError = this.providerError(error);
      this.emitUsage(input.usage, "chat.regenerate", "subtitle", Date.now() - startedAt, undefined, serviceError);
      logWarn("[AI] subtitle regeneration failed", {
        provider: this.config.provider ?? "minimax",
        errorCode: serviceError.code,
        elapsedMs: Date.now() - startedAt,
      });
      throw serviceError;
    }
  }

  /**
   * 用给定客户端发送 chat.completions 请求并取回首个 choice.message；返回时同时附带 traceId
   * （尝试从响应头 trace-id / trace_id / request_id 中取），便于在 DevTools / 日志里串起一次请求。
   * 若接口未返回任何 message，抛 empty_model_output 供上层触发重试。
   */
  private emitUsage(
    usage: { onEvent?: (event: AiUsageEvent) => void } | undefined,
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
        model: this.config.model,
        provider: this.config.provider ?? "minimax",
        durationMs,
        response,
        error,
      }));
    } catch {
      // usage recording must never break the primary call
    }
  }

  private async complete(
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
      model: this.config.model, messages, temperature: 0.1, max_completion_tokens: 8192,
      tools: [responseTool],
      tool_choice: { type: "function" as const, function: { name: "submit_product_update" } },
    };
    // MiniMax 专有参数：thinking、reasoning_split、service_tier。DeepSeek/Evolink 不支持。
    const providerParams = this.isDeepSeek
      ? {}
      : { thinking: { type: "disabled" as const }, reasoning_split: true, service_tier: miniMaxServiceTier() };
    const startedAt = Date.now();
    try {
      const result = await client.chat.completions.create({
        ...baseParams,
        ...providerParams,
      } as never, { signal }).withResponse();
      const response = result.data;
      if (usage?.onEvent) {
        try {
          usage.onEvent(toAiUsageEvent({
            source: usage.source,
            runId: usage.runId,
            attempt: usage.attempt,
            model: this.config.model,
            provider: this.config.provider ?? "minimax",
            durationMs: Date.now() - startedAt,
            response,
          }));
        } catch {
          // ignore recorder failures
        }
      }
      const message = response.choices[0]?.message;
      if (!message) throw new MiniMaxServiceError("empty_model_output", "AI 未返回内容。");
      return { message, traceId: result.response.headers.get("trace-id") || result.response.headers.get("trace_id") || result.request_id || undefined };
    } catch (error) {
      if (usage?.onEvent) {
        try {
          usage.onEvent(toAiUsageEvent({
            source: usage.source,
            runId: usage.runId,
            attempt: usage.attempt,
            model: this.config.model,
            provider: this.config.provider ?? "minimax",
            durationMs: Date.now() - startedAt,
            error,
          }));
        } catch {
          // ignore recorder failures
        }
      }
      throw error;
    }
  }

  /**
   * 把 OpenAI SDK 抛出的任意错误归一化为 MiniMaxServiceError：
   *   - AuthenticationError → provider_authentication
   *   - RateLimitError      → provider_rate_limit
   *   - APIConnectionTimeoutError → provider_timeout
   *   - APIConnectionError  → provider_connection
   *   - 其他                → provider_error
   * 注意：不会包装 MiniMaxServiceError 自身，避免外层 code 被覆写丢失信息。
   */
  private providerError(error: unknown): MiniMaxServiceError {
    if (error instanceof MiniMaxServiceError) return error;
    const label = this.providerLabel;
    if (error instanceof AuthenticationError) return new MiniMaxServiceError("provider_authentication", `${label} API Key 无效。`);
    // 兜底：部分兼容代理 / 中间层抛出的未知错误对象不会带 OpenAI SDK 的 AuthenticationError 实例，
    // 但仍可能携带 HTTP 401 status / statusCode；安全读取后映射为 provider_authentication，避免被误归为 provider_error。
    if (typeof error === "object" && error !== null) {
      const record = error as { status?: unknown; statusCode?: unknown };
      const status = typeof record.status === "number"
        ? record.status
        : typeof record.statusCode === "number"
          ? record.statusCode
          : undefined;
      if (status === 401) return new MiniMaxServiceError("provider_authentication", `${label} API Key 无效。`);
    }
    if (error instanceof RateLimitError) return new MiniMaxServiceError("provider_rate_limit", `${label} 请求过于频繁，请稍后重试。`);
    if (error instanceof APIConnectionTimeoutError) return new MiniMaxServiceError("provider_timeout", `${label} 响应超时，请重试。`);
    if (error instanceof APIConnectionError) return new MiniMaxServiceError("provider_connection", `无法连接 ${label} 服务。`);
    return new MiniMaxServiceError("provider_error", `${label} 服务暂时无法完成本次请求。`);
  }

  /**
   * 把任意错误归一化为 MiniMaxServiceError 并抛出（never 返回值），用于不希望吃异常的同步失败点。
   */
  private throwProviderError(error: unknown): never {
    throw this.providerError(error);
  }
}
