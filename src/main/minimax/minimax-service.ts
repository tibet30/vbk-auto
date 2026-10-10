/**
 * MiniMax / Evolink 客户端封装（MiniMaxService）及其周边工具：
 *   - 调用聊天接口完成规划对话（reply），内置结构化输出解析与重试；
 *   - 调用诊断接口给出自动录入失败的下一步建议（diagnoseAutomationFailure）；
 *   - 在 VBK 下拉候选项本地无法精确匹配时调用消歧接口（disambiguateOption）。
 *
 * 任何 OpenAI SDK 抛出的异常都会被 providerError() 归一化为 MiniMaxServiceError，
 * 外层调用方按 errorCode 决定 retry / 回退 / 报错。
 */

import { rewritePresentationCopy } from "./presentation-copy-rewriter.js";
import type { AdvisorOutcome, AdvisorRequest, AiResponse, AiUsageEvent, AiUsageSource, DisambiguateOutcome, DisambiguateRequest } from "../../shared/contracts.js";
import { logError, logInfo, logWarn } from "../../shared/log-timestamp.js";
import { logAIPrompt } from "../ai/prompt-log.js";
import {
  MiniMaxServiceError,
  systemPrompt,
} from "./minimax-constants.js";
import { buildPlanningMessages, decideRetry, parsePlanningResponse, PLANNING_RETRY_LIMIT } from "./minimax-planning.js";
import {
  completePlanning,
  createMiniMaxClient,
  isDeepSeek,
  miniMaxProviderError,
  providerLabel,
  replyTimeout,
  type MiniMaxConfig,
} from "./minimax-runtime.js";
import {
  diagnoseAutomationFailure as diagnoseAutomationFailureOperation,
  disambiguateOption as disambiguateOptionOperation,
  regenerateSubtitle as regenerateSubtitleOperation,
} from "./minimax-operations.js";

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
  constructor(private readonly config: MiniMaxConfig) {}
  /** 当前 provider 是否为 DeepSeek/Evolink，用于切换 OpenAI 参数（thinking / reasoning_split 等不支持）。 */
  private get isDeepSeek() { return isDeepSeek(this.config); }
  // 错误消息中显示的 provider 名：provider 为 "deepseek" 时显示 "Evolink"，否则默认 "MiniMax"。
  private get providerLabel() { return providerLabel(this.config); }
  /**
   * 构造一个禁用自动重试的 OpenAI 客户端：单轮规划请求必须显式失败，
   * 而非被 SDK 默认重试拖到分钟级，便于上层按 code 决定续跑 / 终止。
   */
  private client(timeout: number) {
    return createMiniMaxClient(this.config, timeout);
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
    } catch (error) { throw miniMaxProviderError(this.config, error); }
  }

  /**
   * 主链路规划对话：以 systemPrompt + history + 用户本轮输入向 AI 请求一次结构化补全，
   * 解析得到 AiResponse（reply / patch / questions / researchTasks），期间对 invalid_model_output
   * / empty_model_output 等可重试错误最多重试 4 次；最终抛 MiniMaxServiceError。
   * 区分首版生成（强制携带 patch）与对话微调（patch 可选但仍要走结构化）。
   */
  async rewritePresentationCopy(input: { message: string; product: Record<string, unknown> }): Promise<AiResponse> {
    if (!this.config.apiKey) throw new MiniMaxServiceError("provider_not_configured", "尚未配置 AI API Key。");
    return rewritePresentationCopy(this.client(replyTimeout()), this.config.model, input);
  }

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
    // 结构化输出保留 4 次修复机会（attempt 0–4，含首次），让外层 ai:send 不必再包网络重试，
    // 也保证 MiniMax.reply 重试日志测试能看到 0/1/2 三次连续 prompt。
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
    for (let attempt = 0; attempt <= PLANNING_RETRY_LIMIT; attempt += 1) {
      const attemptStartedAt = Date.now();
      const messages = buildPlanningMessages({ ...input, systemPrompt, hasExistingDraft, attempt, lastRetryReason });
      try {
        const isLastAttempt = attempt >= PLANNING_RETRY_LIMIT;
        logAIPrompt({
          entry: "MiniMax.reply",
          provider: this.config.provider ?? "minimax",
          model: this.config.model,
          attempt,
          messages,
        });
        const { message, traceId } = await completePlanning(this.config, client, messages, input.usage ? {
          source: input.usage.source,
          runId: input.usage.runId,
          attempt,
          onEvent: input.usage.onEvent,
        } : undefined, input.signal);
        const { response, isStructured, classification } = parsePlanningResponse(message);
        const hasActionHint = !!(response.patch?.length || response.questions?.length || response.researchTasks?.length);
        const hasWritablePatch = !!(response.patch?.length ?? 0);
        // 解析走 fallback 兜底（纯文本回复/未闭合引号/转义截断）的结果可能是 "未获取到..." 等占位文，
        // 这种情况即便 parseRecoveredJson 把它标 structured 也应视为无效，触发重试。
        // 当 reply 来自 model 主动输出（与 content 一致或独立纯文本），即便没有 patch 也允许放过。
        // 但当 reply 看起来是 "暂不写盘"、"等待重试" 等占位文，且没有 patch 落地，仍应触发重试。
        const isFallbackReply = classification.fallback;
        // patch/questions/researchTasks 实际有内容（不是 0 长度）才算真正命中 action。
        // 当 reply 看起来是 fallback 占位文（"仍无可写字段"、"暂不写盘" 等）时，questions/researchTasks 单独命中不算数。
        // patch/questions/researchTasks 实际有内容（不是 0 长度）才算真正命中 action。
        // 当 requiresWritablePatch 强制要求写入 patch 时，questions/researchTasks 单独命中不算数（需要 patch 才能落库）。
        const hasRealActionHint = (response.patch?.length ?? 0) > 0
          || (!requiresWritablePatch && !isFallbackReply && ((response.questions?.length ?? 0) > 0
              || (response.researchTasks?.length ?? 0) > 0));
        // reply 看起来是单字占位（"heartbeat"、"ok"、"done" 之类）时不算实质内容，避免假阳性接受。
        const looksLikeTrivialReply = classification.trivial;
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
          if (hasOfficialToolCall && /截断|待补齐|抓包片段|先返回|先给|暂不可写|占位|未携带/.test(response.reply ?? "") && attempt < PLANNING_RETRY_LIMIT) {
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
          if (hasOfficialToolCall && !hasWritablePatch && /重试|暂缺|仍未/.test(response.reply ?? "") && attempt < PLANNING_RETRY_LIMIT) {
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
        const serviceError = error instanceof MiniMaxServiceError ? error : miniMaxProviderError(this.config, error);
        lastError = serviceError;
        const canRetry = decideRetry(serviceError.code, attempt);
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

  async diagnoseAutomationFailure(input: AdvisorRequest & {
    usage?: { localProductId: string; stage?: string; onEvent?: (event: AiUsageEvent) => void };
  }): Promise<AdvisorOutcome> {
    return diagnoseAutomationFailureOperation(this.config, input);
  }

  async disambiguateOption(input: DisambiguateRequest & {
    usage?: { localProductId: string; stage?: string; onEvent?: (event: AiUsageEvent) => void };
  }): Promise<DisambiguateOutcome> {
    return disambiguateOptionOperation(this.config, input);
  }

  async regenerateSubtitle(input: {
    product: Record<string, unknown>;
    usage?: { localProductId: string; onEvent?: (event: AiUsageEvent) => void };
    signal?: AbortSignal;
  }): Promise<string> {
    return regenerateSubtitleOperation(this.config, input);
  }

}
